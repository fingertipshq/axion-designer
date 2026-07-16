// Negative CSS-in-JS fixture：styled template 與 style={{…}} 都是 style zone。
// 若 zone 判定不辨識 CSS-in-JS，這個檔會掃到卻 0 findings。
// 內含：寫死 hex（含引號）+ AI 預設字型（Inter）+ 紫/靛漸層。
import styled from 'styled-components';

const Card = styled.div`
  color: #ff00aa;                                      /* hardcoded-color */
  font-family: Inter, sans-serif;                      /* ai-font */
  background: linear-gradient(135deg, purple, indigo); /* gradient-hero */
`;

export function Hero() {
  return (
    // 引號包住的 CSS-in-JS 色值仍屬 hardcoded-color。
    <div style={{ color: '#0071e3', background: 'linear-gradient(to right, violet, indigo)' }}>
      <Card>Hi</Card>
    </div>
  );
}
