'use strict';
// App updates have their own setting; this never changes AI CLI updates or
// refreshes the page while a task or draft is active.
var UI = globalThis.HubI18n || { text: value => value, html: value => value, label: value => value, message: value => value, valueAttribute: () => '', dateLocale: 'ja-JP',
  template: (strings, ...values) => strings.reduce((out, part, i) => out + part + (i < values.length ? values[i] : ''), '') };
let appUpdateData = null, appUpdatePending = false, appUpdateEpoch = 0;
const APP_UPDATE_PHASES = {
  idle: '待機中', checking: '更新を確認しています', deferred: '作業が終わるまで待っています',
  preparing: '新版の準備中', translating: '繁体字中国語に翻訳しています', testing: 'テストを実行しています',
  building: 'アプリを作成しています', verifying: 'インストールを確認しています', ready: '適用待ち', installing: '新版を適用しています', installed: '更新済み',
  publishing: '翻訳のPRを送っています', published: '翻訳のPRを送りました', conflict: '手元の変更があるため停止しています',
  failed: '更新に失敗しました', error: '更新に失敗しました'
};
function appUpdateDate(value) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(UI.dateLocale) : UI.text('まだ確認していません');
}
function appUpdateHtml(data) {
  const d = data || {}, disabled = appUpdatePending || d.supported === false ? 'disabled' : '';
  const checking = ['checking', 'preparing', 'translating', 'testing', 'building', 'verifying', 'installing', 'publishing'].includes(d.phase);
  return UI.template`<label class="chk"><input id="app-auto-update" type="checkbox" ${d.enabled ? 'checked' : ''} ${disabled}> Project Hub を自動で更新する</label>
    <p class="small">毎日1回確認します。取得元は kieiken/project-hub です。AI の作業・順番待ちが終わるまで適用を待ちます。この画面を勝手に読み直すことはありません。</p>
    <p class="small">稼働版：<b>${esc(d.sourceVersion || '—')}</b> ／ 最新版：<b>${esc(d.latestVersion || '—')}</b><br>前回の確認：${esc(appUpdateDate(d.lastCheck))}<br>次回の確認：${esc(d.nextCheck ? appUpdateDate(d.nextCheck) : UI.text('未定'))}</p>
    <p class="note" role="status">${esc(UI.text(APP_UPDATE_PHASES[d.phase] || '待機中'))}${d.reason ? '：' + esc(UI.message(d.reason)) : ''}</p>
    ${d.pending ? UI.html('<p class="small">まだ適用していない更新があります。</p>') : ''}
    ${d.autoTranslate ? UI.html('<p class="small">新版を繁体字中国語に翻訳し、テストを通してからアプリを更新します。</p>') : ''}
    ${d.publishEnabled ? UI.html('<p class="small">テストを通した翻訳のPRを、元のプロジェクトへ送ります。</p>') : ''}
    ${d.prUrl ? `<button class="btn plain sm" data-url="${esc(d.prUrl)}" type="button">${UI.text('翻訳のPRを見る')}</button>` : ''}
    ${d.supported === false ? UI.html('<p class="small">このインストールではアプリの自動更新を使えません。</p>') : ''}
    ${d.error ? `<p class="danger" role="status">${esc(UI.message(d.error))}</p>` : ''}
    ${d.publishError && d.publishError !== d.error ? UI.template`<p class="danger" role="status">翻訳PRの送信：${esc(UI.message(d.publishError))}</p>` : ''}
    <div class="acts"><button class="btn plain" id="app-update-check" data-app-update="check" type="button" ${disabled || (checking ? 'disabled' : '')}>今すぐ更新を確認</button><span class="small" id="app-update-status" role="status">${appUpdatePending ? UI.text('確認中…') : ''}</span></div>`;
}
async function loadAppUpdate() {
  const box = $('#app-update-box'); if (!box || appUpdatePending) return;
  const epoch = ++appUpdateEpoch;
  try {
    const data = await api('/api/app-update');
    if ($('#app-update-box') !== box || epoch !== appUpdateEpoch || appUpdatePending) return;
    appUpdateData = data; box.innerHTML = appUpdateHtml(data);
  } catch (error) { if ($('#app-update-box') === box && epoch === appUpdateEpoch) box.textContent = UI.message(error.message); }
}
async function changeAppUpdate(enabled) {
  const box = $('#app-update-box'); if (!box || appUpdatePending || appUpdateData?.supported === false) return;
  const epoch = ++appUpdateEpoch, before = appUpdateData;
  appUpdatePending = true; box.innerHTML = appUpdateHtml(before);
  try {
    const data = await api('/api/app-update', { enabled });
    appUpdateData = data;
    if ($('#app-update-box') === box && epoch === appUpdateEpoch) {
      appUpdatePending = false; box.innerHTML = appUpdateHtml(data);
      $('#app-update-status').textContent = UI.text('自動更新の設定を保存しました');
    }
  } catch (error) {
    if ($('#app-update-box') === box && epoch === appUpdateEpoch) {
      appUpdatePending = false; box.innerHTML = appUpdateHtml(before);
      $('#app-update-status').textContent = UI.message(error.message);
    }
  } finally { appUpdatePending = false; }
}
async function checkAppUpdate() {
  const box = $('#app-update-box'); if (!box || appUpdatePending || appUpdateData?.supported === false) return;
  if (['checking', 'preparing', 'translating', 'testing', 'building', 'verifying', 'installing', 'publishing'].includes(appUpdateData?.phase)) return;
  const epoch = ++appUpdateEpoch;
  appUpdatePending = true; box.innerHTML = appUpdateHtml(appUpdateData);
  try {
    const data = await api('/api/app-update/check', {});
    appUpdateData = data;
    if ($('#app-update-box') === box && epoch === appUpdateEpoch) {
      appUpdatePending = false; box.innerHTML = appUpdateHtml(data);
      $('#app-update-status').textContent = UI.text('更新の状態を表示しました');
    }
  } catch (error) {
    if ($('#app-update-box') === box && epoch === appUpdateEpoch) {
      appUpdatePending = false; box.innerHTML = appUpdateHtml(appUpdateData);
      $('#app-update-status').textContent = UI.message(error.message);
    }
  } finally { appUpdatePending = false; }
}
document.addEventListener('change', event => {
  if (event.target.id === 'app-auto-update' && !event.target.disabled) void changeAppUpdate(event.target.checked);
});
document.addEventListener('click', event => {
  const button = event.target.closest?.('[data-app-update]');
  if (button && !button.disabled) void checkAppUpdate();
});
// Reading status is not another update check. Only the backend schedules the
// once-a-day upstream check, preserving the last-check record across restarts.
setInterval(() => { if (!document.hidden && typeof view !== 'undefined' && view.kind === 'settings' && !appUpdatePending) void loadAppUpdate(); }, 5000);
