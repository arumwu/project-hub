'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const src=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function fixture(){let click;const ctx=vm.createContext({esc,linkify:t=>`PLAIN:${esc(t)}`,document:{addEventListener:(k,cb)=>click=cb},setTimeout(){},copyText:async()=>true});vm.runInContext(src.slice(src.indexOf('// 囲みの中はリンク'),src.indexOf('// コピーできたか')),ctx);return {ctx,click};}
test('fences preserve exact whitespace, multiline Japanese, HTML and path text without links',()=>{
 const f=fixture(),value='　全角  spaces\n<script>"x"</script>\n/Users/a/file.md\n';const out=f.ctx.richText('before\n```text\n'+value+'```\nafter');assert.ok(out.includes('<code>'+esc(value)+'</code>'));assert.doesNotMatch(out,/<script>|data-path=/);assert.match(out,/cb-copy/);assert.match(out,/PLAIN:before/);assert.match(out,/PLAIN:after/);
});
test('multiple/no-language/long fences and incomplete stream fences are distinct',()=>{
 const f=fixture();const out=f.ctx.richText('```\none\n```\n````bash\ntwo\n```\n````\n');assert.equal((out.match(/class="codeblock"/g)||[]).length,2);assert.match(out,/>テキスト</);assert.match(out,/>bash</);assert.match(out,/two\n```\n<\/code>/);
 const partial=f.ctx.richText('```text\nnot yet');assert.match(partial,/書きかけ/);assert.doesNotMatch(partial,/cb-copy/);assert.match(partial,/not yet/);
});
test('copy click passes exact code text, and only success shows success state',async()=>{
 const f=fixture(),text='　h\n"quotes"\n';let copied;
 const b={disabled:false,textContent:'',closest:()=>({querySelector:()=>({textContent:text})})};f.ctx.copyText=async x=>{copied=x;return true;};await f.click({target:{closest:()=>b}});assert.equal(copied,text);assert.equal(b.textContent,'✓ コピーしました');b.disabled=false;f.ctx.copyText=async()=>false;await f.click({target:{closest:()=>b}});assert.doesNotMatch(b.textContent,/コピーしました/);assert.match(b.textContent,/できません/);
});

test('paths and URLs outside fences retain normal links, with no links inside',()=>{
 const c=vm.createContext({esc,document:{addEventListener(){}},setTimeout(){}});
 const start=src.indexOf('const LINK_RE');vm.runInContext(src.slice(start,src.indexOf('// コピーできたか',start)),c);
 const out=c.richText('/Users/example/source.md https://example.com/page\n```text\n/Users/example/source.md\n```');
 assert.match(out,/data-path=/);assert.match(out,/data-url=/);assert.doesNotMatch(out.match(/<code>([\s\S]*?)<\/code>/)[1],/data-path=|data-url=/);
});

test('CRLF in a fenced block is preserved as a character reference through HTML parsing',()=>{assert.match(fixture().ctx.richText('```text\r\nline\r\n```'),/<code>line&#13;\n<\/code>/);});
