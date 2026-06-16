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
        
        const formatField = document.querySelector('input[id*=deck_formato]'); //selection
        if(formatField && data.format){
            formatField.value = data.format;
            formatField.dispatchEvent(new Event('input', {bubbles: true}));
        }
        
        const descriptionField = document.querySelector('textarea[id*=txt_descricao]'); //textarea
        if(descriptionField && data.description){
            descriptionField.value = data.description;
            descriptionField.dispatchEvent(new Event('input', {bubbles: true}));
        }
        
        const deckListField = document.querySelector('textarea[id*=txt_deck]'); //textarea
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

        const createDeckBtn = document.querySelector('button[name*=btCadDeck]'); //(input submit)
        //if popup > auto click
        createDeckBtn.click()
    };

    if (document.readyState === 'loading'){
        document.addEventListener('DOMContentLoaded', fill);
    }else{
        fill();
    }
})