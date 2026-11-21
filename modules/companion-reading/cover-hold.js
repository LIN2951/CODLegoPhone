const HOLD_MS = 500;
const MOVE_LIMIT = 12;

export function bindCoverHold(grid, onHold) {
    let hold;
    let suppressClick = false;

    function cancelHold() {
        if (!hold) return;
        clearTimeout(hold.timer);
        hold = null;
    }

    function coverButton(target) {
        const button = target.closest?.('.book-cover')?.closest('.book-open');
        return button && grid.contains(button) ? button : null;
    }

    window.addEventListener('pointerdown', event => {
        const interrupted = !!hold;
        cancelHold();
        if (!event.isPrimary) {
            if (interrupted) suppressClick = true;
            return;
        }
        suppressClick = false;
        if (event.button !== 0) return;
        const button = coverButton(event.target);
        if (!button) return;

        const { pointerId, clientX, clientY } = event;
        const timer = setTimeout(() => {
            hold = null;
            if (!button.isConnected) return;
            suppressClick = true;
            onHold(button);
        }, HOLD_MS);
        hold = { pointerId, clientX, clientY, timer };
    }, true);

    window.addEventListener('pointermove', event => {
        if (hold?.pointerId !== event.pointerId) return;
        const distance = Math.hypot(event.clientX - hold.clientX, event.clientY - hold.clientY);
        if (distance <= MOVE_LIMIT) return;
        suppressClick = true;
        cancelHold();
    }, true);

    function finish(event) {
        if (hold?.pointerId === event.pointerId) cancelHold();
    }
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
    window.addEventListener('blur', cancelHold);

    // A held pointer can synthesize a click after the dialog has already opened.
    window.addEventListener('click', event => {
        if (!suppressClick || !event.detail) return;
        suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);

    grid.addEventListener('contextmenu', event => {
        if (coverButton(event.target)) event.preventDefault();
    });
}
