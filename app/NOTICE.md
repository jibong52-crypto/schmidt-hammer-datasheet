# 제3자 구성요소와 라이선스

이 앱은 아래 오픈소스를 그대로 포함(번들)합니다. 모두 상업적 이용이 가능한 허용적 라이선스입니다.

| 구성요소 | 위치 | 라이선스 | 출처 |
| --- | --- | --- | --- |
| **PP-OCRv4** 텍스트 검출 모델 (`ch_PP-OCRv4_det_infer`) | `models/det.onnx` | Apache-2.0 | PaddleOCR, © PaddlePaddle Authors — https://github.com/PaddlePaddle/PaddleOCR |
| **PP-OCRv4** 텍스트 인식 모델 (`ch_PP-OCRv4_rec_infer`) + 글자 사전 (`ppocr_keys_v1.txt`) | `models/rec.onnx`, `models/dict.txt` | Apache-2.0 | 위와 같음. ONNX 변환본은 npm 패키지 `@gutenye/ocr-models` 1.4.2 (MIT, https://github.com/gutenye/ocr)에서 가져옴 |
| **ONNX Runtime Web** 1.31.1 | `vendor/ort/` | MIT | https://github.com/microsoft/onnxruntime |
| **qrcode-generator** 2.0.4 (휴대폰 접속용 QR 생성) | `vendor/qrcode/qrcode.mjs` | MIT (© Kazuhiko Arase, 파일 머리말에 표기) | https://github.com/kazuhikoarase/qrcode-generator |

전/후처리(검출 후처리, 글줄 기울기 추정, CTC 디코딩, 기록지 해석)는 이 저장소에서 직접 구현했습니다 (`js/ocr/`).

개발·테스트에만 쓰는 도구(런타임에는 포함되지 않음): `onnxruntime-node`(MIT), `sharp`(Apache-2.0).
