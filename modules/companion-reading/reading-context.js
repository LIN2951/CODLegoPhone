import { createShelfStore } from './shelf-store.js?v=2';
import { sample } from './sample-book.js';

export function createReadingContext(scope) {
    const store = createShelfStore(scope);
    return async function getReadingContext({ bookId, chapterIndex, readChapterIndices = [] }) {
        const builtin = bookId === sample.id;
        const [record, content] = await Promise.all([
            store.record(bookId), builtin ? sample : store.content(bookId)
        ]);
        const chapters = content?.chapters;
        const currentChapter = chapters?.[chapterIndex];
        if (record?.hidden || (!builtin && !record) || !currentChapter) {
            throw new Error('找不到本轮共读的书籍或章节，请回到书页重新发送。');
        }
        const readChapters = [...new Set(readChapterIndices)]
            .filter(index => Number.isInteger(index) && index >= 0 && index !== chapterIndex && index < chapters.length)
            .map(index => chapters[index]);
        return { title: record?.title || content.title, currentChapter, readChapters };
    };
}
