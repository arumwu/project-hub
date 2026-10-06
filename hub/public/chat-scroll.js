/* DOMを書き換える前の位置で追従を判断し、同じ作業の再描画でも読んでいる位置を保つ。 */
(() => {
  window.HubChatScroll = {
    capture(box, key) {
      return box && box.dataset.scrollKey === key ? { top: box.scrollTop, follow: box.scrollHeight - box.scrollTop - box.clientHeight < 80 } : null;
    },
    create(box, latest, saved) {
      let first = true;
      const capture = () => ({ top: box.scrollTop, follow: box.scrollHeight - box.scrollTop - box.clientHeight < 80 });
      const indicator = () => { if (latest) latest.hidden = capture().follow; };
      const restore = (position, force = false) => {
        box.scrollTop = force || position.follow ? box.scrollHeight : position.top;
        indicator();
      };
      box.addEventListener('scroll',indicator);
      latest?.addEventListener('click', () => restore(capture(),true));
      return { capture, restore, rows(position) { restore(first ? (saved || {follow:true}) : position); first = false; } };
    }
  };
})();
