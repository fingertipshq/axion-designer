// CSS-in-JS 的 camelCase 顏色屬性必須與 kebab-case 屬性接受相同檢查。
export function Card() {
  return (
    <div style={{ backgroundColor: '#ff0000', borderColor: '#00ff00', boxShadow: '0 0 0 1px #0000ff' }}>
      <span style={{ color: '#123456' }}>kebab/camel 同形的 color 作對照（本來就抓得到）</span>
    </div>
  );
}
