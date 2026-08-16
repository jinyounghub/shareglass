# ShareGlass 한국어 안내

**공유하기 전에 파일이 무엇을 노출하는지 확인하세요.**

ShareGlass는 이미지·Microsoft Office 문서·PDF 내부에 남아 있는 개인정보, 위치, 협업 흔적, 외부 연결, 활성 콘텐츠와 출처 정보를 찾아 설명하는 로컬 우선 오픈소스입니다. 웹앱에서는 선택한 파일이 서버로 업로드되지 않고 현재 브라우저 탭 안에서 처리됩니다.

## 바로 체험하기

GitHub Pages에서 **Try a private résumé**, **Try a geotagged image**, **Try an active PDF** 중 하나를 누르면 실제 개인정보가 아닌 합성 샘플로 전체 과정을 확인할 수 있습니다.

1. 파일 또는 샘플을 선택합니다.
2. 위험 점수와 발견 항목을 확인합니다.
3. 각 항목을 열어 증거와 파일 내부 경로를 봅니다.
4. 지원되는 형식은 제거 항목을 선택해 안전한 복사본을 만듭니다.
5. ShareGlass가 새 복사본을 다시 검사하고 콘텐츠 지문을 비교합니다.

## 지원 범위

- **JPEG·PNG·WebP:** EXIF, GPS, XMP, IPTC, 텍스트·댓글·시간 정보와 C2PA 구조 표식을 검사합니다. 지원되는 메타데이터만 제거한 복사본을 만들 수 있습니다.
- **DOCX:** 작성자, 마지막 편집자, 회사명, 댓글과 검토자, 변경 내용 추적, 숨은 텍스트, 사용자 정의 XML, 외부 링크·템플릿, 썸네일, 포함 객체, 매크로와 서명을 검사합니다.
- **XLSX·PPTX:** 문서 속성, 외부 연결, 숨은 시트·슬라이드, 메모·댓글, 포함 객체, 매크로와 서명을 검사합니다.
- **PDF:** 문서 속성, XMP, URL, JavaScript와 자동 실행, 첨부파일, 양식, 암호화, 서명, 증분 저장 흔적을 검사합니다. v1에서는 PDF 자동 수정 기능을 제공하지 않습니다.

검사 결과는 악성 코드 부재, 완전한 익명성 또는 파일 안전성을 보증하지 않습니다. ShareGlass는 구조적으로 확인한 증거를 보여주는 사전 점검 도구입니다.

## 안전한 복사본 원칙

- 원본 파일을 덮어쓰지 않습니다.
- 기본 정리는 Office 작성자·응용프로그램 속성, Word 댓글, 문서 썸네일을 대상으로 합니다.
- 사용자 정의 XML 제거, 외부 링크 무력화, 변경 내용 수락은 선택 기능입니다.
- Office 디지털 서명 또는 Content Credentials가 의심되는 경우 명시적인 확인 없이는 수정하지 않습니다.
- 생성된 복사본을 다시 검사합니다.
- 표시 콘텐츠를 기준으로 만든 지문이 동일한지 비교합니다.

## CLI 사용

```bash
node bin/shareglass.mjs scan samples/private-resume.docx
node bin/shareglass.mjs scan release/* --fail-on high
node bin/shareglass.mjs scan contract.pdf --json
node bin/shareglass.mjs clean resume.docx --custom-data --neutralize-links
```

## 개발 및 검증

Node.js 22 이상이 필요하며 런타임·개발 의존성이 없습니다.

```bash
npm run check
npm test
npm run build
```

세 명령을 모두 실행하려면 `npm run ci`를 사용합니다.

## 개인정보 처리

ShareGlass 웹앱에는 파일 업로드 엔드포인트, 사용자 계정, 분석 도구가 없습니다. 선택형 C2PA 검증 버튼을 누를 때에만 공식 브라우저 SDK와 WASM 파일을 CDN에서 불러오며, 선택한 파일 자체는 ShareGlass가 전송하지 않습니다. 완전한 오프라인 환경에서는 해당 SDK 자산을 직접 호스팅하거나 C2PA 검증을 사용하지 않으면 됩니다.

자세한 내용은 루트의 `PRIVACY.md`, `SECURITY.md`와 `docs/THREAT_MODEL.md`를 확인하세요.
