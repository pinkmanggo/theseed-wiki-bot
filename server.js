const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ==========================================
// 1. 세이프가드 (보호 구역 마스킹)
// ==========================================
function maskProtectedSections(text) {
    const protectedBlocks = [];
    const patterns = [
        /<!--[\s\S]*?-->/g,                  // 1. HTML 주석
        /<nowiki>[\s\S]*?<\/nowiki>/gi,       // 2. nowiki 태그
        /\{\{\{[\s\S]*?\}\}\}/g,              // 3. {{{ 코드 블록 }}}
        /https?:\/\/[^\s\]\}]+/g,             // 4. 외부 URL 주소
        /^\s*>.*$/gm,                         // 5. 인용문 라인
        /\[quote\([\s\S]*?\)]/gi              // 6. [quote()] 문법
    ];

    let maskedText = text;
    patterns.forEach(pattern => {
        maskedText = maskedText.replace(pattern, (match) => {
            protectedBlocks.push(match);
            return `__PROTECTED_BLOCK_${protectedBlocks.length - 1}__`;
        });
    });

    return { maskedText, protectedBlocks };
}

function restoreProtectedSections(text, protectedBlocks) {
    let restoredText = text;
    protectedBlocks.forEach((block, idx) => {
        restoredText = restoredText.replace(`__PROTECTED_BLOCK_${idx}__`, block);
    });
    return restoredText;
}

// ==========================================
// 2. 대상 검사기 (이름공간 및 분류 필터)
// ==========================================
function checkEligibility(docTitle, docContent, filters = {}) {
    const { targetNamespace, targetCategory } = filters;

    // 이름공간 검사
    if (targetNamespace && targetNamespace !== '전체') {
        const hasNamespace = docTitle.includes(':');
        const currentNamespace = hasNamespace ? docTitle.split(':')[0] : '문서';
        if (currentNamespace !== targetNamespace) {
            return { eligible: false, reason: `이름공간 불일치 (현재: ${currentNamespace} / 대상: ${targetNamespace})` };
        }
    }

    // 특정 분류 검사
    if (targetCategory && targetCategory.trim() !== '') {
        const categoryRegex = new RegExp(`\\[분류:\\s*${targetCategory.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]`, 'i');
        if (!categoryRegex.test(docContent)) {
            return { eligible: false, reason: `분류 [분류:${targetCategory}] 미포함` };
        }
    }

    return { eligible: true };
}

// ==========================================
// 3. 외부 API 최신화 모듈 (유튜브, KOBIS 등)
// ==========================================
async function fetchExternalData(type, targetId, apiKey) {
    if (!type || !targetId) return null;
    try {
        if (type === 'YOUTUBE' && apiKey) {
            const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${targetId}&key=${apiKey}`;
            const res = await axios.get(url, { timeout: 5000 });
            const count = res.data.items?.[0]?.statistics?.subscriberCount;
            return count ? parseInt(count).toLocaleString('ko-KR') + '명' : null;
        } else if (type === 'KOBIS' && apiKey) {
            const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, '');
            const url = `http://www.kobis.or.kr/kobisopenapi/webservice/rest/boxoffice/searchDailyBoxOfficeList.json?key=${apiKey}&targetDt=${yesterday}`;
            const res = await axios.get(url, { timeout: 5000 });
            const list = res.data.boxOfficeResult?.dailyBoxOfficeList || [];
            const movie = list.find(m => m.movieCd === targetId || m.movieNm === targetId);
            return movie ? parseInt(movie.audiAcc).toLocaleString('ko-KR') + '명' : null;
        }
    } catch (err) {
        console.error(`외부 API (${type}) 조회 실패:`, err.message);
    }
    return null;
}

// ==========================================
// 4. 종합 규칙 및 치환 엔진
// ==========================================
function applyWikiRules(text, options = {}) {
    let result = text;

    // A. 사용자 설정 단어/정규식 치환
    if (options.customSearch) {
        const searchPattern = options.useRegex 
            ? new RegExp(options.customSearch, 'g') 
            : new RegExp(options.customSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        result = result.replace(searchPattern, options.customReplace || '');
    }

    // B. 기본 자동 교정 규칙들
    if (options.autoClean) {
        // 역링크 정리 (문서, 분류, 파일, 틀)
        if (options.oldName && options.newName) {
            const oldEsc = options.oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const newName = options.newName;

            result = result.replace(new RegExp(`\\[\\[${oldEsc}(?:\\|([^\\]]+))?\\]\\]`, 'g'), 
                (m, p1) => p1 ? `[[${newName}|${p1}]]` : `[[${newName}|${options.oldName}]]`);
            result = result.replace(new RegExp(`\\[분류:${oldEsc}\\]`, 'g'), `[분류:${newName}]`);
            result = result.replace(new RegExp(`\\[include\\(\\s*틀:${oldEsc}([\\s,\\)])`, 'g'), `[include(틀:${newName}$1`);
        }

        // 유튜브 URL 정리
        result = result.replace(/(https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[\w-]+)(&[\w-&=]+)/g, '$1');
        result = result.replace(/(https?:\/\/youtu\.be\/[\w-]+)(\?[\w-&=]+)/g, '$1');

        // 문단 제목 하이퍼링크 제거
        result = result.replace(/^(={1,6})\s*\[\[(?:[^|\]]*\|)?([^\]]+)\]\]\s*\1$/gm, '$1 $2 $1');

        // 다크모드 배경색 통합 (#191919, #1f2023 -> #1c1d1f)
        result = result.replace(/#(?:191919|1f2023)/gi, '#1c1d1f');
    }

    // C. 외부 API 수치 최신화 반영
    if (options.liveValue && options.targetParam) {
        const paramRegex = new RegExp(`(\\|\\s*${options.targetParam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*)([^\\n\\|]+)`, 'g');
        result = result.replace(paramRegex, `$1${options.liveValue}`);
    }

    return result;
}

// ==========================================
// 5. 대시보드 웹 UI
// ==========================================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="ko">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>더시드/나무위키 통합 봇 제어판</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 800px; margin: 30px auto; padding: 0 20px; background: #f4f6f8; color: #333; }
            .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            h2, h3 { margin-top: 0; color: #111; }
            .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
            .form-group { margin-bottom: 12px; }
            label { display: block; font-weight: 600; margin-bottom: 5px; font-size: 14px; }
            input, select, textarea { width: 100%; padding: 10px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; }
            textarea { height: 90px; resize: vertical; font-family: monospace; }
            .checkbox-group { display: flex; align-items: center; gap: 10px; margin: 10px 0; }
            .checkbox-group input { width: auto; }
            button { width: 100%; padding: 14px; background: #0066ff; color: white; border: none; font-size: 16px; font-weight: bold; cursor: pointer; border-radius: 4px; transition: background 0.2s; }
            button:hover { background: #0052cc; }
            #logs { background: #1e1e1e; color: #00ff66; padding: 15px; border-radius: 6px; height: 250px; overflow-y: auto; font-family: monospace; font-size: 13px; white-space: pre-wrap; }
        </style>
    </head>
    <body>
        <h2>🤖 위키 봇 통합 제어판 (The Seed Engine)</h2>
        
        <div class="card">
            <h3>1. 기본 설정 & 접속 정보</h3>
            <div class="grid">
                <div class="form-group">
                    <label>위키 API 도메인</label>
                    <input type="text" id="baseUrl" value="https://theseed.io/api">
                </div>
                <div class="form-group">
                    <label>API Bearer 토큰</label>
                    <input type="password" id="token" placeholder="Bearer 토큰 입력">
                </div>
            </div>
            <div class="form-group">
                <label>대상 문서 목록 (줄바꿈으로 구분)</label>
                <textarea id="docList" placeholder="더시드위키:연습장&#10;문서A&#10;틀:가수_정보"></textarea>
            </div>
        </div>

        <div class="card">
            <h3>2. 대상 필터링 조건</h3>
            <div class="grid">
                <div class="form-group">
                    <label>이름공간 지정</label>
                    <select id="targetNamespace">
                        <option value="전체">전체 (제한 없음)</option>
                        <option value="문서">일반 문서</option>
                        <option value="틀">틀</option>
                        <option value="분류">분류</option>
                        <option value="사용자">사용자</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>특정 분류 포함 문서만 지정</label>
                    <input type="text" id="targetCategory" placeholder="예: 한국 가수 (빈칸 시 전체)">
                </div>
            </div>
        </div>

        <div class="card">
            <h3>3. 편집 작업 및 규칙 설정</h3>
            <div class="checkbox-group">
                <input type="checkbox" id="autoClean" checked>
                <label for="autoClean">기본 문법 자동 정돈 (역링크, 유튜브 파라미터, 문단명 링크, 다크모드 색상)</label>
            </div>
            
            <div class="grid">
                <div class="form-group">
                    <label>구 문서명 (역링크 정리용)</label>
                    <input type="text" id="oldName" placeholder="예: A">
                </div>
                <div class="form-group">
                    <label>신 문서명 (역링크 정리용)</label>
                    <input type="text" id="newName" placeholder="예: B">
                </div>
            </div>

            <hr style="margin: 15px 0; border: none; border-top: 1px solid #eee;">

            <div class="grid">
                <div class="form-group">
                    <label>찾을 문자열 / 정규식</label>
                    <input type="text" id="customSearch" placeholder="치환 대상">
                </div>
                <div class="form-group">
                    <label>바꿀 문자열</label>
                    <input type="text" id="customReplace" placeholder="치환될 내용">
                </div>
            </div>
            <div class="checkbox-group">
                <input type="checkbox" id="useRegex">
                <label for="useRegex">찾을 문자열에 정규식(Regex) 적용하기</label>
            </div>

            <div class="form-group">
                <label>편집 요약 (Log)</label>
                <input type="text" id="editLog" value="[자동/봇] 문법 정돈 및 역링크 교정 작업">
            </div>

            <div class="checkbox-group" style="background: #fff8e1; padding: 10px; border-radius: 4px;">
                <input type="checkbox" id="isDryRun" checked>
                <label for="isDryRun"><strong>[세이프가드] 시뮬레이션 모드 (Dry Run):</strong> 실제로 저장하지 않고 변경 내역만 미리 확인합니다.</label>
            </div>
        </div>

        <button onclick="startBot()">🚀 작업 시작하기</button>

        <div class="card" style="margin-top: 20px;">
            <h3>실행 로그</h3>
            <div id="logs">대기 중... 작업 시작 버튼을 눌러주세요.</div>
        </div>

        <script>
            function appendLog(text) {
                const logs = document.getElementById('logs');
                logs.innerText += '\\n' + text;
                logs.scrollTop = logs.scrollHeight;
            }

            async function startBot() {
                document.getElementById('logs').innerText = '[시작] 작업 세션을 개시합니다...';

                const docListRaw = document.getElementById('docList').value.trim();
                if (!docListRaw) {
                    alert('대상 문서 목록을 최소 하나 이상 입력해줘.');
                    return;
                }

                const payload = {
                    baseUrl: document.getElementById('baseUrl').value.trim(),
                    token: document.getElementById('token').value.trim(),
                    docList: docListRaw.split('\\n').map(d => d.trim()).filter(d => d),
                    filters: {
                        targetNamespace: document.getElementById('targetNamespace').value,
                        targetCategory: document.getElementById('targetCategory').value.trim()
                    },
                    options: {
                        autoClean: document.getElementById('autoClean').checked,
                        oldName: document.getElementById('oldName').value.trim(),
                        newName: document.getElementById('newName').value.trim(),
                        customSearch: document.getElementById('customSearch').value,
                        customReplace: document.getElementById('customReplace').value,
                        useRegex: document.getElementById('useRegex').checked,
                        isDryRun: document.getElementById('isDryRun').checked
                    },
                    editLog: document.getElementById('editLog').value.trim()
                };

                try {
                    const res = await fetch('/api/run-batch', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });

                    const data = await res.json();
                    if (!data.success) {
                        appendLog('[에러] ' + data.message);
                        return;
                    }

                    appendLog('\\n=== 작업 결과 요약 ===');
                    data.summary.forEach(item => {
                        appendLog(\`[\${item.status}] 문서: \${item.doc} \${item.reason ? ' - ' + item.reason : ''} \${item.rev ? '(리비전: ' + item.rev + ')' : ''}\`);
                    });

                } catch (err) {
                    appendLog('[통신 에러] ' + err.message);
                }
            }
        </script>
    </body>
    </html>
    `);
});

// ==========================================
// 6. 메인 배치 작업 API Endpoint
// ==========================================
app.post('/api/run-batch', async (req, res) => {
    const { baseUrl, token, docList, filters, options, editLog } = req.body;

    if (!token || !Array.isArray(docList) || docList.length === 0) {
        return res.json({ success: false, message: 'API 토큰과 대상 문서 목록이 비어있습니다.' });
    }

    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    const summary = [];
    const apiBase = baseUrl || 'https://theseed.io/api';

    for (const docTitle of docList) {
        try {
            // 1. GET: 문서 읽기
            const url = `${apiBase}/edit/${encodeURIComponent(docTitle)}`;
            const getRes = await axios.get(url, { headers, timeout: 10000 });
            
            const originalText = getRes.data.text || '';
            const editToken = getRes.data.token;

            if (!editToken) {
                summary.push({ doc: docTitle, status: 'SKIP', reason: '편집 권한 없음 또는 보호된 문서' });
                continue;
            }

            // 2. 대상 검사 (이름공간 및 분류 조건)
            const check = checkEligibility(docTitle, originalText, filters);
            if (!check.eligible) {
                summary.push({ doc: docTitle, status: 'SKIP', reason: check.reason });
                continue;
            }

            // 3. 예외 마스킹 -> 규칙 적용 -> 마스킹 복원
            const { maskedText, protectedBlocks } = maskProtectedSections(originalText);
            const updatedMasked = applyWikiRules(maskedText, options);
            const finalText = restoreProtectedSections(updatedMasked, protectedBlocks);

            // 4. 변경 사항 존재 확인
            if (originalText === finalText) {
                summary.push({ doc: docTitle, status: 'SKIP', reason: '변경할 대상 구문이 없음' });
                continue;
            }

            // 5. 시뮬레이션 모드(Dry Run)
            if (options?.isDryRun) {
                summary.push({ doc: docTitle, status: 'DRY_RUN', reason: '성공적으로 치환 대상 감지됨 (저장 안 함)' });
                continue;
            }

            // 6. POST: 저장
            const postPayload = {
                text: finalText,
                log: editLog || '[자동/봇] 조건별 문서 정돈',
                token: editToken
            };

            const postRes = await axios.post(url, postPayload, { headers, timeout: 10000 });
            summary.push({ doc: docTitle, status: 'SUCCESS', rev: postRes.data.rev });

            // API rate limit 대응 (3초 대기)
            await new Promise(resolve => setTimeout(resolve, 3000));

        } catch (err) {
            summary.push({ doc: docTitle, status: 'ERROR', reason: err.response?.data?.message || err.message });
        }
    }

    return res.json({ success: true, summary });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Wiki Bot Active on Port ${PORT}`));
