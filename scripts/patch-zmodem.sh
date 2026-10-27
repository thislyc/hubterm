#!/bin/sh
# zmodem.js 0.1.10 兼容补丁（lrzsz 窗口模式），可重复执行：
# 补丁1: lrzsz 的 sz 每 1024 字节发一个 ZCRCW(frame_end) 帧并等待 ZACK；
#        原库只对 !frame_end 帧回 ZACK，导致接收方向卡死（真实 lrzsz rz 抓包：每帧都回 ZACK）。
# 补丁2: accept() 后的头处理器只注册 ZEOF；lrzsz 窗口模式每个 1KB 窗口都是新 ZDATA 头，
#        第二个 ZDATA 抛 "Unhandled header"。改为自引用 map，持续接受 ZDATA。
# 仅补 src（ZMODEM 在主进程运行，不用 dist）。
set -e
cd "$(dirname "$0")/.."

node - <<'EOF'
const fs = require('fs');
const f = 'node_modules/zmodem.js/src/zsession.js';
let txt = fs.readFileSync(f, 'utf8');

// ---------- 补丁 1 ----------
const OLD1 = 'if (subpacket.ack_expected() && !subpacket.frame_end()) {';
const NEW1 = 'if (subpacket.ack_expected()) {  // HubTerm patch 1: ZACK every ack_expected frame (lrzsz windowed mode)';
if (txt.includes(NEW1)) {
  console.log('patch1: already applied');
} else if (txt.includes(OLD1)) {
  txt = txt.replace(OLD1, NEW1);
  console.log('patch1: applied');
} else {
  // 可能存在旧版补丁文案，还原后再打
  const t = txt.replace(/if \(subpacket\.ack_expected\(\)\) \{[^\n]*HubTerm[^\n]*\n/, OLD1 + '\n');
  if (t === txt) throw new Error('patch1: target not found');
  txt = t.replace(OLD1, NEW1);
  console.log('patch1: applied (after revert)');
}

// ---------- 补丁 2 ----------
const MARK2 = 'var hdr_map = {  // HubTerm patch 2';
if (txt.includes(MARK2)) {
  console.log('patch2: already applied');
} else {
  // 还原可能的旧版补丁2（on_ZDATA_more 版本）
  const stale = /                        ZDATA: function on_ZDATA_more\(hdr\) \{\n(?:.*\n)*?                        \},\n                    \};/;
  if (stale.test(txt)) {
    txt = txt.replace(stale, '                    };');
    console.log('patch2: stale version reverted');
  }
  const ORIG_HEAD = '                    this._next_header_handler = {\n                        ZEOF: function on_ZEOF(hdr) {';
  const i = txt.indexOf(ORIG_HEAD);
  if (i < 0) throw new Error('patch2: target not found');
  const j = txt.indexOf('                    };', i);
  if (j < 0) throw new Error('patch2: end not found');
  const original = txt.slice(i, j + '                    };'.length);
  const body = original
    .replace('                    this._next_header_handler = {', '                    var hdr_map = {  // HubTerm patch 2: self-referencing map, keep accepting ZDATA windows')
    .replace(
      '                        },\n                    };',
      `                        },
                        ZDATA: function on_ZDATA_more(hdr) {
                            this._consume_ZDATA(hdr);
                            this._next_subpacket_handler = this._consume_ZDATA_data;
                            this._next_header_handler = hdr_map;
                        },
                    };`
    )
    .replace(
      '                    var hdr_map = {',
      `                    this._next_header_handler = null; // placeholder, replaced below\n                    var hdr_map = {`
    );
  // 上面插了个占位，去掉；实际赋值在 map 定义之后
  const finalBlock = body
    .replace('                    this._next_header_handler = null; // placeholder, replaced below\n', '')
    + '\n                    this._next_header_handler = hdr_map;';
  txt = txt.slice(0, i) + finalBlock + txt.slice(j + '                    };'.length);
  console.log('patch2: applied');
}

fs.writeFileSync(f, txt);
EOF
echo "✓ zmodem.js 补丁完成"
