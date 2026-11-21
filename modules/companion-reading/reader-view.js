const clamp = (value, lower, upper) => Math.min(upper, Math.max(lower, value));

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

export function createReader({ onPosition, onNotice }) {
    const viewport = document.getElementById('reading-viewport');
    const flow = document.getElementById('reading-flow');
    let book, mode, position, observer, pdf, layoutNumber = 0, layoutFrame, scrollTimer, scrollReady = false;

    function pageMetrics() {
        const width = viewport.clientWidth || 1;
        const height = viewport.clientHeight || 1;
        const max = mode === 'horizontal' ? viewport.scrollWidth - width : viewport.scrollHeight - height;
        const step = mode === 'horizontal' ? width : Math.round(height * .88);
        const total = 1 + (mode === 'horizontal' ? Math.round(max / step) : Math.ceil(max / step));
        const current = mode === 'horizontal' ? viewport.scrollLeft : viewport.scrollTop;
        return { step, max: Math.max(0, max), page: clamp(Math.round(current / step) + 1, 1, total), total, current };
    }

    function location() {
        const { max, current, page, total } = pageMetrics();
        return { ...position, offset: max ? clamp(current / max, 0, 1) : 0, page, total };
    }

    function atEnd() {
        const { max, current } = pageMetrics();
        return current >= max - 2;
    }

    function setOffset(offset) {
        const { max, step } = pageMetrics();
        let value = clamp(offset || 0, 0, 1) * max;
        if (mode === 'horizontal') value = Math.round(value / step) * step;
        viewport.scrollTo(mode === 'horizontal' ? { left: value, top: 0 } : { left: 0, top: value });
    }

    function applyLayout(offset) {
        scrollReady = false;
        cancelAnimationFrame(layoutFrame);
        clearTimeout(scrollTimer);
        const sequence = ++layoutNumber;
        viewport.dataset.mode = mode;
        document.documentElement.style.setProperty('--viewport-height', `${viewport.clientHeight}px`);
        setOffset(offset);
        layoutFrame = requestAnimationFrame(() => {
            if (!book || sequence !== layoutNumber) return;
            setOffset(offset);
            scrollReady = true;
            onPosition(location(), atEnd());
        });
    }

    function stopPdf() {
        observer?.disconnect();
        observer = undefined;
        const previous = pdf;
        pdf = undefined;
        if (previous) void previous.then(reader => reader.destroy()).catch(() => {});
    }

    function startPdf(pages) {
        const source = book.pdfSource;
        for (const page of pages) {
            const node = element('figure', 'pdf-page');
            node.dataset.page = page;
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            canvas.setAttribute('aria-label', `PDF 原稿第 ${page} 页`);
            node.append(canvas, element('figcaption', '', `原稿第 ${page} 页`));
            flow.append(node);
        }
        const start = import('./book-import.js').then(module => module.openPdfReader(source));
        // Attach a handler even if the user leaves before the first page intersects.
        void start.catch(() => {});
        pdf = start;
        observer = new IntersectionObserver(entries => {
            for (const { target, isIntersecting } of entries) {
                const canvas = target.querySelector('canvas');
                const caption = target.querySelector('figcaption');
                if (!isIntersecting) {
                    delete target.dataset.nearby;
                    if (target.dataset.rendered) {
                        delete target.dataset.rendered;
                        canvas.width = canvas.height = 1;
                    }
                    continue;
                }
                target.dataset.nearby = 'true';
                if (target.dataset.loading || target.dataset.rendered || target.dataset.failed) continue;
                target.dataset.loading = 'true';
                void start.then(reader => {
                    if (pdf !== start || !target.dataset.nearby) return false;
                    return reader.renderPage(Number(target.dataset.page), canvas, target.clientWidth);
                }).then(rendered => {
                    if (rendered && pdf === start && target.dataset.nearby) target.dataset.rendered = 'true';
                    else canvas.width = canvas.height = 1;
                }).catch(() => {
                    target.dataset.failed = 'true';
                    caption.textContent = `原稿第 ${target.dataset.page} 页暂时无法显示`;
                }).finally(() => { delete target.dataset.loading; });
            }
        }, { root: viewport, rootMargin: '75px', threshold: .02 });
        flow.querySelectorAll('.pdf-page').forEach(page => observer.observe(page));
    }

    function show(nextBook, nextPosition, settings) {
        const nextChapter = clamp(nextPosition?.chapter || 0, 0, nextBook.chapters.length - 1);
        const chapter = nextBook.chapters[nextChapter];
        document.getElementById('reader-title').textContent = nextBook.title;
        document.getElementById('reader-chapter').textContent = chapter.title;
        book = nextBook;
        mode = settings.mode;
        position = { chapter: nextChapter };
        document.documentElement.style.setProperty('--reader-size', `${settings.size}px`);
        stopPdf();
        flow.replaceChildren();
        const intro = element('header', 'chapter-intro');
        if (!chapter.pdfPages?.length) {
            const painting = document.createElement('img');
            painting.src = 'art/chapter.jpg';
            painting.alt = '';
            painting.width = 1180;
            painting.height = 472;
            intro.append(painting);
        }
        intro.append(element('h2', '', chapter.title));
        flow.append(intro);
        const text = document.createDocumentFragment();
        for (const paragraph of (chapter.paragraphs || [])) text.append(element('p', '', paragraph));
        flow.append(text);
        if (chapter.pdfPages?.length && book.pdfSource) startPdf(chapter.pdfPages);
        applyLayout(nextPosition?.offset);
    }

    function scrollPage(direction) {
        if (!book) return false;
        const { step, max, current } = pageMetrics();
        if ((direction < 0 && current < 2) || (direction > 0 && current >= max - 2)) return false;
        const next = clamp(current + step * direction, 0, max);
        viewport.scrollTo(mode === 'horizontal' ? { left: Math.round(next / step) * step } : { top: next });
        onPosition(location(), atEnd());
        return true;
    }

    function visiblePdfPage() {
        const view = viewport.getBoundingClientRect();
        return [...flow.querySelectorAll('.pdf-page')].find(node => {
            const rect = node.getBoundingClientRect();
            return rect.right > view.left + 2 && rect.left < view.right - 2 && rect.bottom > view.top + 2 && rect.top < view.bottom - 2;
        })?.dataset.page;
    }

    function passage() {
        const current = location();
        const chapter = book.chapters[current.chapter];
        const page = chapter.pdfPages?.length ? visiblePdfPage() : undefined;
        const place = page ? `PDF 原稿第 ${page} 页` : `${chapter.title} · ${current.page}/${current.total} 页`;
        return { bookId: book.id, title: book.title, chapter: chapter.title, chapterIndex: current.chapter, locator: place };
    }

    viewport.addEventListener('scroll', () => {
        if (!scrollReady) return;
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => { if (book && scrollReady) onPosition(location(), atEnd()); }, 90);
    }, { passive: true });

    let viewportSize = '';
    const relayout = () => {
        if (!book) return;
        const size = `${viewport.clientWidth}/${viewport.clientHeight}`;
        if (viewportSize === size) return;
        viewportSize = size;
        if (scrollReady) applyLayout(location().offset);
    };
    const resize = new ResizeObserver(relayout);
    resize.observe(viewport);
    document.fonts?.ready.then(() => { if (book && scrollReady) applyLayout(location().offset); });

    return {
        show, location, passage, atEnd, scrollPage,
        configure(settings) {
            if (!book || (mode === settings.mode && document.documentElement.style.getPropertyValue('--reader-size') === `${settings.size}px`)) return;
            const previous = location();
            mode = settings.mode;
            document.documentElement.style.setProperty('--reader-size', `${settings.size}px`);
            applyLayout(previous.offset);
            onNotice(mode === 'horizontal' ? '可点击正文左侧或右侧翻页' : '可上下滑动，也可点正文上侧或下侧');
        },
        clear() {
            ++layoutNumber;
            cancelAnimationFrame(layoutFrame);
            clearTimeout(scrollTimer);
            scrollReady = false;
            stopPdf();
            book = undefined;
            flow.replaceChildren();
        }
    };
}
