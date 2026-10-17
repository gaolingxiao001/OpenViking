import qrcode from 'qrcode-terminal';

// A QR code in the terminal, with the link as a fallback for screens where
// the code is too dense to scan (Feishu's full permission set makes ~1600 chars).
export function showQr(output, url, title) {
  output.write(`\n${title}\n`);
  qrcode.generate(url, { small: true }, (code) => output.write(`${code}\n`));
  output.write(`扫不出来的话，把终端调宽或缩小字体，或在飞书里打开这个链接：\n${url}\n\n`);
}
