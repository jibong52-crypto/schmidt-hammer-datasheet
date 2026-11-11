// 이 기기에만 저장하는 양식 설정 (문서에 들어가지 않고 모든 문서에 똑같이 적용된다).
//  · 사진대지의 인쇄 머리글(오른쪽 위)·바닥글(맨 아래 오른쪽): 회사 양식마다 문구가 달라 코드에 넣지 않고 사용자가 한 번 적어 둔다.
const KEY = 'schmidt.sheettext.v1';

export function getSheetText() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { head: typeof d.head === 'string' ? d.head : '', foot: typeof d.foot === 'string' ? d.foot : '' };
  } catch { return { head: '', foot: '' }; }
}

export function setSheetText(patch) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...getSheetText(), ...patch })); return true; } catch { return false; }
}
