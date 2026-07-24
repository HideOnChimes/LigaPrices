// IIFE: content script roda como script clássico — `return` no top-level é
// SyntaxError ("Illegal return statement"). Envolver permite o early-return.
(() => {
// Relay de fetch da LigaMagic (first-party). O service worker pede que ESTA aba busque
// a página da carta. Como roda em ligamagic.com.br, o fetch é mesmo-origem → carrega o
// cookie cf_clearance do Cloudflare e não sofre CORS. Contorna o HTTP 403 que o SW leva
// quando o navegador bloqueia cookies de terceiros no contexto do worker.
// Registrado em TODA página da Liga (fora do guard de view=dks/novo).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if(!msg || msg.type !== 'ligaFetchRelay') return;
    fetch(msg.url, {
        credentials: 'include',
        headers: { 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'pt-BR,pt;q=0.9' },
    })
        .then(async r => sendResponse({ ok: r.ok, status: r.status, text: r.ok ? await r.text() : null }))
        .catch(e => sendResponse({ ok: false, status: 0, error: String((e && e.message) || e) }));
    return true; // resposta assíncrona
});

if(!location.search.includes('view=dks/novo')) return;

chrome.storage.local.get('liga_export_pending', ({liga_export_pending: data}) => {
    chrome.storage.local.remove('liga_export_pending');
    if(!data || Date.now() - data.ts > 60000) return;

    const fill = () => {
        const nameField = document.querySelector('input[id*=deck_nome]');
        if(nameField && data.name){
            nameField.value = data.name;  
            nameField.dispatchEvent(new Event('input', {bubbles: true}))
        } 
        
        const FORMAT_MAP = {
            'standard': '1',
            'modern': '3',
            'commander': '9',
            'legacy': '4',
            'vintage': '5',
            'pauper': '15',
            'frontier': '12',
            'brawl': '6',
            'custom': '22',
            'future standard': '1',
            'penny dreadful': '22',
            '1v1 commander': '10',
            'dual commander': '10',
        }

        const formatField = document.querySelector('select[id*=deck_formato]'); //selection
        if(formatField && data.format){
            const val = FORMAT_MAP[data.format.toLowerCase().trim()];
            
            if(val){
                formatField.value = val;
                formatField.dispatchEvent(new Event('change', {bubbles: true}));
            }
            console.log('[Liga import] data.format:', JSON.stringify(data.format), 'val:', FORMAT_MAP[data.format.toLowerCase().trim()]);

        }
        
        const descriptionField = document.querySelector('textarea[id*=txt_descricao]'); //textarea
        if(descriptionField && data.description){
            descriptionField.value = data.description;
            descriptionField.dispatchEvent(new Event('input', {bubbles: true}));
        }
        
        const deckListField = document.querySelector('textarea#txt_deck'); //textarea
        if(deckListField && data.deckList){
            deckListField.value = data.deckList;
            deckListField.dispatchEvent(new Event('input', {bubbles: true}));
        }
        
        const sideboardField = document.querySelector('textarea[id*=txt_side]'); //textarea
        if(sideboardField && data.sideboard){
            sideboardField.value = data.sideboard;
            sideboardField.dispatchEvent(new Event('input', {bubbles: true}));
        }
        
        const maybeboardField = document.querySelector('textarea[id*=txt_maybe]'); //textarea
        if(maybeboardField && data.maybeboard){
            maybeboardField.value = data.maybeboard;
            maybeboardField.dispatchEvent(new Event('input', {bubbles: true}));
        }

        // Espera fn() retornar truthy (polling). Resolve com o valor ou null no timeout.
        const waitFor = (fn, tries = 60, gap = 100) => new Promise(res => {
            const t = () => { const r = fn(); if(r || tries-- <= 0) res(r || null); else setTimeout(t, gap); };
            t();
        });

        // Dropdown ativo do autocomplete (display:block + tem sugestões)
        const findSuggBox = () => {
            for(const box of document.querySelectorAll('.auto-sugg .autocomplete')){
                if(getComputedStyle(box).display !== 'none' && box.querySelector('div[title]')) return box;
            }
            return null;
        };

        // Preenche 1 campo de comandante e comita escolhendo a sugestão de title exato.
        // O campo é autocomplete (devbridge jQuery): setar .value não basta, é preciso
        // disparar a seleção na sugestão (mousedown vence o blur que fecharia a lista).
        const fillCommanderField = async (sel, name) => {
            const el = document.querySelector(sel);
            if(!el || !name) return;
            el.focus();
            el.value = name;
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new KeyboardEvent('keyup', {bubbles: true}));

            const box = await waitFor(findSuggBox);
            if(!box) return;
            const opts = [...box.querySelectorAll('div[title]')];
            const target = opts.find(o => o.getAttribute('title') === name)
                        || box.querySelector('div.selected')
                        || opts[0];
            if(!target) return;
            ['mousedown','mouseup','click'].forEach(type =>
                target.dispatchEvent(new MouseEvent(type, {bubbles: true})));
        };

        // Campos de comandante só nascem após o change do formato; preenchidos em
        // sequência (o dropdown do autocomplete é único e depende do foco).
        if(data.commanders?.length){
            (async () => {
                await waitFor(() => {
                    const c = document.querySelector('[id*=txt_deck_commander]:not([id*=parceiro])');
                    return c && !c.disabled && !c.readOnly ? c : null;
                });
                await fillCommanderField('[id*=txt_deck_commander]:not([id*=parceiro])', data.commanders[0]);
                if(data.commanders[1])
                    await fillCommanderField('[id*=txt_deck_commanderparceiro]', data.commanders[1]);
            })();
        }

        const createDeckBtn = document.querySelector('button[name*=btCadDeck]'); //(input submit)
        //if popup > auto click
        //if(createDeckBtn) createDeckBtn.click();
    };

    if (document.readyState === 'loading'){
        document.addEventListener('DOMContentLoaded', fill);
    }else{
        fill();
    }
})
})();