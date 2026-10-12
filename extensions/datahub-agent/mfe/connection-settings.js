const errors = {
  query_settings_admin_required: "需要DataHub管理政策及管理ingestion權限。",
  query_settings_duplicate_binding: "相同來源定位已有啟用的連線，請修改原連線或先停用它。",
  query_settings_version_conflict: "設定已變更，請關閉並重新讀取；不要重送保存。",
  source_settings_version_conflict: "設定已變更，請關閉並重新讀取；不要重送保存。",
  source_settings_configuration_changed: "設定被外部修改，需由部署端重新載入Host。",
  source_settings_save_unconfirmed: "保存結果未確認；請關閉並重新讀回，不要重送。",
  query_settings_password_required: "新增連線必須輸入密碼；既有密碼留空表示保留。",
  query_settings_invalid_connection: "請核對主機、埠、帳號及資料庫；資料庫必須符合選取的metadata。",
  query_settings_metadata_unsupported: "第一版支援無platform instance的SQL Server metadata。",
  query_connection_unavailable: "既有受保護憑證不可讀，請由部署管理員確認。",
};
function message(value) { return errors[value?.error] ?? `操作未完成（${value?.error ?? "query_settings_request_failed"}），不自動重試。`; }
function element(tag, text) { const node = document.createElement(tag); if (text) node.textContent = text; return node; }

/** Credentials are entered only here, on the trusted DataHub origin. The Pi
 * iframe can open a form, never send a password, save or a test command. */
function connectionDialog({ container, input, initial, send, signal }) {
  return new Promise((resolve) => {
    const opener = document.activeElement, dialog = element("dialog"), form = element("form"), fields = element("fieldset");
    dialog.style.cssText = "width:min(720px,94vw);max-height:90dvh;overflow:auto;box-sizing:border-box;padding:20px;border:1px solid #ddd;border-radius:12px;background:white;color:#37352f";
    dialog.setAttribute("aria-label", "SQL Server資料庫連線"); form.autocomplete = "off";
    const heading = element("h2", "SQL Server資料庫連線"), note = element("p", "此為共用查詢連線，使用者仍受自己的DataHub metadata可見性限制。密碼只送可信Host，不進入Pi、模型或聊天。請使用來源最小唯讀權限帳號。"), status = element("p");status.setAttribute("role", "status");
    fields.style.cssText = "min-width:0;border:0;padding:0";
    const controls = {};
    function field(name, label, value = "", type = "text") {
      const row = element("label", label), control = element("input"); control.name = name; control.type = type; control.value = String(value); control.autocomplete = type === "password" ? "new-password" : "off";
      row.style.cssText = "display:block;margin:12px 0;overflow-wrap:anywhere"; control.style.cssText = "display:block;box-sizing:border-box;width:100%;min-height:40px;margin-top:4px;padding:8px;font:inherit"; row.append(control);fields.append(row);controls[name] = control;return control;
    }
    const id = field("id", "連線識別名稱（英數、底線、連字號）", input.id ?? ""); id.required = true;id.pattern = "[A-Za-z0-9][A-Za-z0-9_-]{0,63}";id.maxLength = 64;id.readOnly = !!input.id;
    const search = field("search", "搜尋已匯入的SQL Server Dataset（例如AdventureWorks2019）");
    const searchButton = element("button", "搜尋Dataset"), choices = element("select"); searchButton.type = "button";choices.setAttribute("aria-label", "參考Dataset");choices.style.cssText = "width:100%;min-height:40px";choices.append(new Option(input.id ? "保留既有metadata定位" : "請搜尋並選擇一個Dataset", ""));fields.append(searchButton, choices);
    const location = element("p", initial?.binding ? `既有定位：${initial.binding.database} · ${initial.binding.environment}` : "由選取Dataset核定來源定位；不是授予整库metadata權限。");location.style.overflowWrap = "anywhere";fields.append(location);
    const c = initial?.connection;
    field("host", "SQL Server主機（不含URL或instance，請使用明確TCP埠）", c?.host).required = true;
    const port = field("port", "TCP埠", c?.port ?? 1433, "number");port.min = "1";port.max = "65535";port.required = true;
    field("database", "實際資料庫名稱", c?.database).required = true;
    field("username", "SQL登入帳號", c?.username).required = true;
    const password = field("password", input.id ? "新密碼（留空保留；原密碼不回顯）" : "密碼", "", "password");password.required = !input.id;password.maxLength = 2048;
    const tlsLabel = element("label", "傳輸保護"), tls = element("select");tls.setAttribute("aria-label", "傳輸保護");tls.style.cssText = "display:block;width:100%;min-height:40px";
    if (input.id) tls.append(new Option(`保留既有設定（${c?.tls === "verified" ? "驗證TLS" : "未設定TLS"}）`, "retain"));
    tls.append(new Option("驗證TLS（Host系統CA；不接受未驗證憑證）", "system"), new Option("不設定TLS（僅供已核准的受保護本機／測試網路）", "plaintext"));tlsLabel.append(tls);fields.append(tlsLabel);
    const consentLabel = element("label"), consent = element("input");consent.type = "checkbox";consentLabel.style.cssText = "display:block;margin:16px 0";consentLabel.append(consent, document.createTextNode(" 我確認來源定位與帳號，了解共用連線及所選傳輸保護；只用於唯讀查詢。"));fields.append(consentLabel);
    const test = element("button", "測試連線"), save = element("button", "確認並保存"), toggle = element("button", initial?.binding?.enabled === false ? "啟用連線" : "停用連線"), close = element("button", "取消／關閉");
    for (const button of [searchButton, test, save, toggle, close]) {button.type = "button";button.style.cssText = "min-height:44px;padding:8px 12px;margin:8px 8px 8px 0;font:inherit";}
    fields.append(test, save);if(input.id) fields.append(toggle);form.append(fields);dialog.append(heading,note,form,status,close);container.append(dialog);
    let done = false, busy = false, uncertain = false, changed = false;
    function finish() { if(done)return;done=true;password.value="";signal.removeEventListener("abort",finish);dialog.close();dialog.remove();if(opener?.isConnected)opener.focus();resolve({format:"datahub-connection-settings/1",closed:true,changed}); }
    close.onclick = finish;dialog.oncancel = (e)=>{e.preventDefault();if(!busy)finish();};signal.addEventListener("abort",finish,{once:true});form.onsubmit=(e)=>e.preventDefault();
    async function perform(operation, mutation = false) {
      if(busy||uncertain||signal.aborted)return;busy=true;fields.disabled=true;close.disabled=true;status.textContent="正在向可信Host核對…";
      try {const value=await operation();if(signal.aborted||done)return;
        if(value.error){if(mutation){uncertain=true;status.textContent=message(value)+" 請關閉並重新讀回。";}else status.textContent=message(value);return;}
        if(value.status==="SAVED_AND_ACTIVE"){changed=true;uncertain=true;password.value="";status.textContent="已保存並立即套用。請關閉以重新讀取；未執行業務查詢或ingestion。";}
        else if(value.status==="CONNECTED")status.textContent="連線與固定SELECT 1成功；尚未驗證业务資料表的SELECT權限。未保存設定。";
        else if(Array.isArray(value.datasets)){choices.replaceChildren(new Option(input.id?"保留既有metadata定位":"請選擇Dataset",""));for(const d of value.datasets)choices.append(new Option(d.name+" · "+d.urn,d.urn));status.textContent=value.more?"只列前20筆，請縮小搜尋條件。":"請選擇符合目標資料庫的Dataset。";}
        else {uncertain=mutation;status.textContent="結果無法確認，請重新讀回。";}
      } catch {uncertain=mutation;status.textContent="結果未確認；不自動重試，請關閉並重新讀回。";}
      finally {busy=false;if(!done){fields.disabled=uncertain;close.disabled=false;}}
    }
    const payload=()=>({revision:initial?.revision??input.revision,id:id.value,existing:!!input.id,datasetUrn:choices.value,connection:{host:controls.host.value.trim(),port:Number(port.value),database:controls.database.value.trim(),username:controls.username.value,password:password.value,tls:tls.value}});
    function ready(){if(!form.reportValidity())return false;if(!consent.checked){status.textContent="請先確認來源與傳輸保護。";return false;}if(!input.id&&!choices.value){status.textContent="請選擇參考Dataset以核對metadata定位。";return false;}return true;}
    searchButton.onclick=()=>{if(!search.value.trim())return;void perform(()=>send({action:"search",query:search.value.trim()},signal));};
    test.onclick=()=>{if(ready())void perform(()=>send({action:"test",...payload()},signal));};
    save.onclick=()=>{if(ready())void perform(()=>send({action:"save",...payload()},signal),true);};
    toggle.onclick=()=>{if(!consent.checked){status.textContent="請勾選確認後才可變更啟用狀態。";return;}void perform(()=>send({action:"set_enabled",revision:initial.revision,id:input.id,enabled:initial.binding.enabled===false},signal),true);};
    if(signal.aborted)finish();else{dialog.showModal();id.focus();}
  });
}

export function installConnectionSettingsBridge({ container, frame, origin, send }) {
  let pending;
  const listener=async(event)=>{
    if(event.source!==frame.contentWindow||event.origin!==origin||event.data?.type!=="datahub-connection-settings")return;
    const port=event.ports?.[0];if(!port)return;
    const reply=(v)=>port.postMessage(JSON.stringify(v));
    if(pending){reply({error:"query_settings_busy"});port.close();return;}
    const abort=new AbortController();pending=abort;const timer=setTimeout(()=>abort.abort(),600000);port.onmessage=(e)=>{if(e.data?.type==="cancel")abort.abort();};
    try {
      if(typeof event.data.body!=="string"||event.data.body.length>4096)throw new Error();
      const input=JSON.parse(event.data.body);
      if(input.action==="list"&&Object.keys(input).length===1){reply(await send(input,abort.signal));}
      else if(input.action==="open"&&Object.keys(input).every(k=>["action","id","revision"].includes(k))&&typeof input.revision==="string"){
        const initial=input.id?await send({action:"inspect",id:input.id},abort.signal):await send({action:"list"},abort.signal);
        if(initial.error){reply(initial);return;}
        if(initial.revision!==input.revision){reply({error:"query_settings_version_conflict"});return;}
        const result=await connectionDialog({container,input,initial,send,signal:abort.signal});if(!abort.signal.aborted)reply(result);
      } else throw new Error();
    }catch{if(!abort.signal.aborted)reply({error:"query_settings_request_failed"});}
    finally{clearTimeout(timer);port.close();if(pending===abort)pending=undefined;}
  };
  window.addEventListener("message",listener);
  return()=>{window.removeEventListener("message",listener);pending?.abort();};
}
