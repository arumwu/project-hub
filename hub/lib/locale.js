'use strict';

// Only application-owned phrases are translated. Interpolated user text,
// filenames, persisted identifiers and CLI model names are kept verbatim.
const messages = require('../locales/zh-TW.json');
const locale = () => process.env.HUB_LANG === 'zh-TW' ? 'zh-TW' : 'ja';
function lt(source, ...values) {
  const template = Array.isArray(source) && Object.hasOwn(source, 'raw');
  const key = template ? source.map((part, i) => part + (i < values.length ? '${' + i + '}' : '')).join('') : String(source);
  const text = locale() === 'zh-TW' ? messages[key] || key : key;
  return template ? text.replace(/\$\{(\d+)\}/g, (all, index) => String(values[Number(index)])) : text;
}
const headings = {
  '手順': '步驟', 'やったこと': '已完成的工作', '次にやること': '下一步',
  '注意': '注意事項', 'メモ': '備註',
};
const sectionNames = heading => {
  const canonical = Object.keys(headings).find(key => key === heading || headings[key] === heading) || heading;
  const aliases = { 'やったこと': ['已完成的事'], '次にやること': ['接下來要做的事'], '注意': ['注意'] };
  return [...new Set([canonical, headings[canonical] || canonical, ...(aliases[canonical] || [])])];
};
const sectionName = heading => locale() === 'zh-TW' ? headings[heading] || heading : heading;
const labels = {
  '未着手': '未開始', '実行中': '執行中', '進行中': '進行中', '返事待ち': '等待回覆',
  '完了': '完成', '完了確認待ち': '等待完成確認', '人': '使用者',
  '司令塔': '指揮', '設計': '設計', '実装': '實作', 'チェック': '檢查', '調査': '研究',
  'デザイン': '設計', '画像生成': '圖片生成', 'コーディング': '程式設計', '文章': '文字', '最終確認': '最終確認',
  '中': '中', '高': '高', '極高': '極高', '未解決': '未解決', '確認待ち': '等待確認',
  '判断待ち': '等待決定', '解決済み': '已解決', '履歴': '歷史',
};
const label = value => locale() === 'zh-TW' ? labels[value] || value : value;
function config() { const language = locale(); return { locale: language, language, messages: language === 'zh-TW' ? messages : {} }; }
function configScript() {
  return 'window.HUB_LOCALE = ' + JSON.stringify(config()).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ';';
}
module.exports = { lt, locale, config, configScript, sectionNames, sectionName, label };
