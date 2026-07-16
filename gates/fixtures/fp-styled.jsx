// Negative CSS-in-JS fixture：style、sx 與 css 內聯物件都屬 style zone；
// 引號字串中的 off-scale 值與寫死色都應產生 finding。
export function Panel() {
  return (
    <div style={{ margin: '13px' }}>
      <span sx={{ padding: '13px', color: '#ff00aa' }}>a</span>
      <span css={{ margin: '13px', color: '#ff00aa' }}>b</span>
    </div>
  );
}
