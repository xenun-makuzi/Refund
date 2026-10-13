(() => {
  "use strict";
  const db = window.refundSupabase;
  const $ = (s, root = document) => root.querySelector(s);
  const el = {
    email: $("#wf-user-email"), role: $("#wf-user-role"), signOut: $("#wf-signout"), refresh: $("#wf-refresh"), message: $("#wf-global-message"),
    createForm: $("#wf-create-form"), name: $("#wf-name"), slug: $("#wf-slug"), description: $("#wf-description"), category: $("#wf-category"), origin: $("#wf-origin"),
    stepTemplate: $("#wf-step-template"), selectedSummary: $("#wf-selected-summary"), stepForm: $("#wf-step-form"), stepKey: $("#wf-step-key"), stepLabel: $("#wf-step-label"), stepDescription: $("#wf-step-description"), stepVisible: $("#wf-step-visible"), stepEvidence: $("#wf-step-evidence"), stepTerminal: $("#wf-step-terminal"),
    templateCount: $("#wf-template-count"), templateList: $("#wf-template-list"), claim: $("#wf-claim"), assignTemplate: $("#wf-assign-template"), assignNote: $("#wf-assign-note"), assignForm: $("#wf-assign-form"),
    run: $("#wf-run"), runSummary: $("#wf-run-summary"), nextStep: $("#wf-next-step"), advanceNote: $("#wf-advance-note"), advanceForm: $("#wf-advance-form")
  };
  let user = null, templates = [], steps = [], claims = [], runs = [];
  const claimMap = new Map(), templateMap = new Map(), stepMap = new Map();
  const categoryLabels = {purchase_refund:"Purchase refund", scam_recovery:"Scam recovery", tax_refund:"Tax refund", service_dispute:"Service dispute", other:"Other"};
  const originLabels = {direct:"Direct", partner_referral:"Partner referral"};
  const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; };
  function showMessage(text, kind = "info") { el.message.hidden = false; el.message.className = `control-message${kind === "error" ? " is-error" : kind === "warning" ? " is-warning" : ""}`; el.message.textContent = text; el.message.scrollIntoView({behavior:"smooth",block:"nearest"}); }
  function clearMessage() { el.message.hidden = true; el.message.textContent = ""; el.message.className = "control-message"; }
  function errorText(error) { return error?.message || "Something went wrong. Refresh the page and try again."; }
  function fmtDate(value) { if (!value) return "—"; const d = new Date(value); return Number.isNaN(d.getTime()) ? "—" : new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(d); }
  function safeSlug(value) { return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,""); }
  function addOption(select, value, label) { select.add(new Option(label, value)); }
  function setOptions(select, items, placeholder, getValue, getLabel) { select.replaceChildren(); addOption(select, "", placeholder); for (const item of items) addOption(select, getValue(item), getLabel(item)); }
  function stepsFor(templateId) { return steps.filter(s => s.workflow_id === templateId).sort((a,b)=>a.position-b.position); }
  function templateScope(t) { return `${t.applies_to_category ? categoryLabels[t.applies_to_category] : "All categories"} · ${t.applies_to_origin ? originLabels[t.applies_to_origin] : "All sources"}`; }
  function renderStepList(container, template) {
    const list = stepsFor(template.id);
    if (!list.length) { container.append(node("p","muted","No stages defined yet.")); return; }
    const wrap = node("div","stage-list");
    list.forEach((s,i)=>{ const item=node("div","stage-item"); item.append(node("span","stage-number",String(i+1))); const copy=node("div"); copy.append(node("strong","",s.label),node("small","",s.description || s.step_key)); const meta=node("div","stage-meta"); if(s.customer_visible) meta.append(node("span","small-tag","Customer visible")); else meta.append(node("span","small-tag","Internal")); if(s.requires_evidence) meta.append(node("span","small-tag","Evidence required")); if(s.is_terminal) meta.append(node("span","small-tag","Final stage")); item.append(copy,meta); wrap.append(item); }); container.append(wrap);
  }
  function renderTemplates() {
    el.templateCount.textContent = `${templates.length} template${templates.length===1?"":"s"}`;
    setOptions(el.stepTemplate, templates, "Choose a workflow…", t=>t.id, t=>`${t.name}${t.is_active?" · Active":" · Draft"}`);
    el.templateList.replaceChildren();
    if (!templates.length) { el.templateList.append(node("p","muted","No workflows yet. Create one above.")); }
    for (const t of templates) {
      const card=node("article","template-card"); const top=node("div","template-card-top"); const copy=node("div"); copy.append(node("h3","",t.name),node("span","slug",t.slug)); const actions=node("div");
      const edit=node("button","button button-outline","Add stages"); edit.type="button"; edit.addEventListener("click",()=>{el.stepTemplate.value=t.id; renderSelectedTemplate(); el.stepForm.scrollIntoView({behavior:"smooth",block:"center"});}); actions.append(edit);
      const toggle=node("button",`button ${t.is_active?"button-quiet":"button-primary"}`,t.is_active?"Deactivate":"Activate"); toggle.type="button"; toggle.addEventListener("click",()=>toggleTemplate(t)); actions.append(toggle);
      top.append(copy,actions); card.append(top); card.append(node("p","",t.description || "No description supplied."));
      const tags=node("div","tag-row"); tags.append(node("span","small-tag",templateScope(t)),node("span","small-tag",`${stepsFor(t.id).length} stage${stepsFor(t.id).length===1?"":"s"}`),node("span",`pill ${t.is_active?"is-success":""}`,t.is_active?"Active":"Draft")); card.append(tags);
      renderStepList(card,t); el.templateList.append(card);
    }
    updateAssignmentTemplateOptions(); updateRunOptions();
  }
  function renderSelectedTemplate() {
    const t=templateMap.get(el.stepTemplate.value); el.selectedSummary.replaceChildren();
    if(!t){el.selectedSummary.textContent="Choose a workflow to see its stages."; el.stepForm.querySelector("button[type=submit]").disabled=true; return;}
    el.stepForm.querySelector("button[type=submit]").disabled=t.is_active;
    const title=node("strong","",t.name); const stageMount=node("div"); el.selectedSummary.append(title,node("br"),document.createTextNode(`${templateScope(t)}. ${t.is_active?"Deactivate before editing stages.":"Next stage position will be assigned automatically."}`),stageMount);
    renderStepList(stageMount,t);
  }
  async function toggleTemplate(t) {
    clearMessage();
    const list=stepsFor(t.id);
    if(!t.is_active){
      if(!list.length){showMessage("Add at least one stage before activating a workflow.","warning");return;}
      if(!list[list.length-1].is_terminal){showMessage("Mark the last stage as final before activating this workflow.","warning");return;}
      if(list.slice(0,-1).some(s=>s.is_terminal)){showMessage("Only the last stage should be marked final.","warning");return;}
    }
    const {error}=await db.from("claim_workflow_templates").update({is_active:!t.is_active}).eq("id",t.id);
    if(error){showMessage(errorText(error),"error");return;}
    await loadData(); showMessage(`Workflow ${t.is_active?"deactivated":"activated"}.`);
  }
  function updateAssignmentTemplateOptions() {
    const claim=claimMap.get(el.claim.value);
    const choices=templates.filter(t=>t.is_active && stepsFor(t.id).length && (!t.applies_to_category||!claim||t.applies_to_category===claim.category) && (!t.applies_to_origin||!claim||t.applies_to_origin===claim.origin));
    const previous=el.assignTemplate.value; setOptions(el.assignTemplate,choices,choices.length?"Select an active workflow…":"No matching active workflow",t=>t.id,t=>t.name);
    if(choices.some(t=>t.id===previous)) el.assignTemplate.value=previous;
  }
  function updateRunOptions() {
    const activeRuns=runs.filter(r=>!r.completed_at);
    const previous=el.run.value;
    setOptions(el.run,activeRuns,"Select a running workflow…",r=>r.id, r=>{
      const c=claimMap.get(r.claim_id), t=templateMap.get(r.workflow_id), s=stepMap.get(r.current_step_id);
      return `${c?.case_reference || "Case"} · ${t?.name || "Workflow"} · ${s?.label || "Current stage"}`;
    });
    if(activeRuns.some(r=>r.id===previous)) el.run.value=previous;
    updateNextSteps();
  }
  function updateNextSteps() {
    const run=runs.find(r=>r.id===el.run.value); el.nextStep.replaceChildren();
    if(!run){addOption(el.nextStep,"","Select a run first");el.runSummary.textContent="Choose a run to inspect its current and next stages.";return;}
    const current=stepMap.get(run.current_step_id); const list=stepsFor(run.workflow_id); const next=list.find(s=>current&&s.position>current.position);
    const c=claimMap.get(run.claim_id); const t=templateMap.get(run.workflow_id);
    el.runSummary.replaceChildren(); el.runSummary.append(node("strong","",`${c?.case_reference || "Case"} · ${t?.name || "Workflow"}`),node("br"),document.createTextNode(`Current stage: ${current?.label || "Unknown"}. ${run.completed_at?"Completed.":next?`Next stage: ${next.label}.`:"No next stage; mark the last stage as final and review the template."}`));
    if(next) addOption(el.nextStep,next.id,`${next.label}${next.is_terminal?" · Final":""}`); else addOption(el.nextStep,"","No next stage available");
  }
  async function loadData() {
    clearMessage();
    const [tRes,sRes,cRes,rRes]=await Promise.all([
      db.from("claim_workflow_templates").select("*").order("created_at",{ascending:false}),
      db.from("claim_workflow_steps").select("*").order("position",{ascending:true}),
      db.from("claims").select("id,case_reference,title,category,origin,status,assigned_to,created_at").order("created_at",{ascending:false}).limit(500),
      db.from("claim_workflow_runs").select("*").order("started_at",{ascending:false}).limit(500)
    ]);
    const firstError=[tRes,sRes,cRes,rRes].find(x=>x.error)?.error;
    if(firstError){showMessage(`${errorText(firstError)} If this mentions a missing table, run migration 007 first.`,"error");return;}
    templates=tRes.data||[];steps=sRes.data||[];claims=cRes.data||[];runs=rRes.data||[];
    templateMap.clear();templates.forEach(t=>templateMap.set(t.id,t));stepMap.clear();steps.forEach(s=>stepMap.set(s.id,s));claimMap.clear();claims.forEach(c=>claimMap.set(c.id,c));
    setOptions(el.claim,claims,"Select a claim…",c=>c.id,c=>`${c.case_reference} · ${c.title} (${categoryLabels[c.category]||c.category})`);
    renderTemplates(); renderSelectedTemplate(); updateAssignmentTemplateOptions(); updateRunOptions();
  }
  async function guard() {
    if(!db||!window.refundSupabaseReady){showMessage("Supabase is not connected. Check js/config.js and js/supabase-client.js.","error");return false;}
    const {data,error}=await db.auth.getUser();if(error||!data?.user){window.location.assign("../login.html");return false;}user=data.user;el.email.textContent=user.email||"Signed-in user";
    const {data:roles,error:roleError}=await db.from("user_roles").select("role").eq("user_id",user.id);
    if(roleError){showMessage(errorText(roleError),"error");return false;}
    const allowed=(roles||[]).some(x=>["admin","super_admin"].includes(x.role));
    if(!allowed){showMessage("Administrator access is required to manage workflows.","error");return false;}
    el.role.textContent="Administrator access verified";return true;
  }
  el.name.addEventListener("input",()=>{if(!el.slug.dataset.edited)el.slug.value=safeSlug(el.name.value);});
  el.slug.addEventListener("input",()=>{el.slug.dataset.edited="true";el.slug.value=safeSlug(el.slug.value);});
  el.createForm.addEventListener("submit",async e=>{e.preventDefault();clearMessage();const name=el.name.value.trim(),slug=safeSlug(el.slug.value);if(!name||!slug){showMessage("Enter a workflow name and unique slug.","warning");return;}const payload={name,slug,description:el.description.value.trim()||null,applies_to_category:el.category.value==="all"?null:el.category.value,applies_to_origin:el.origin.value==="all"?null:el.origin.value,is_active:false,created_by:user.id};const {error}=await db.from("claim_workflow_templates").insert(payload);if(error){showMessage(errorText(error),"error");return;}el.createForm.reset();el.slug.dataset.edited="";await loadData();showMessage("Workflow template created as a draft. Add its stages before activating.");});
  el.stepTemplate.addEventListener("change",renderSelectedTemplate);
  el.stepForm.addEventListener("submit",async e=>{e.preventDefault();clearMessage();const template=templateMap.get(el.stepTemplate.value);if(!template){showMessage("Choose a workflow first.","warning");return;}if(template.is_active){showMessage("Deactivate this workflow before adding stages.","warning");return;}const existing=stepsFor(template.id);const key=el.stepKey.value.trim(),label=el.stepLabel.value.trim();if(!key||!label){showMessage("Enter both a step key and stage label.","warning");return;}if(existing.some(s=>s.step_key===key)){showMessage("That step key already exists in this workflow. Choose another key.","warning");return;}if(existing.some(s=>s.is_terminal)){const {error:demoteError}=await db.from("claim_workflow_steps").update({is_terminal:false}).eq("workflow_id",template.id).eq("is_terminal",true);if(demoteError){showMessage(errorText(demoteError),"error");return;}}const payload={workflow_id:template.id,step_key:key,label,description:el.stepDescription.value.trim()||null,position:existing.length?Math.max(...existing.map(s=>s.position))+1:1,customer_visible:el.stepVisible.checked,requires_evidence:el.stepEvidence.checked,is_terminal:el.stepTerminal.checked};const {error}=await db.from("claim_workflow_steps").insert(payload);if(error){showMessage(errorText(error),"error");return;}el.stepForm.reset();el.stepVisible.checked=true;await loadData();el.stepTemplate.value=template.id;renderSelectedTemplate();showMessage("Stage added.");});
  el.claim.addEventListener("change",updateAssignmentTemplateOptions);
  el.assignForm.addEventListener("submit",async e=>{e.preventDefault();clearMessage();if(!el.claim.value||!el.assignTemplate.value){showMessage("Choose a claim and matching active workflow.","warning");return;}const {error}=await db.rpc("admin_assign_claim_workflow",{p_claim_id:el.claim.value,p_workflow_id:el.assignTemplate.value,p_note:el.assignNote.value.trim()||null});if(error){showMessage(errorText(error),"error");return;}el.assignNote.value="";await loadData();showMessage("Workflow assigned to the claim.");});
  el.run.addEventListener("change",updateNextSteps);
  el.advanceForm.addEventListener("submit",async e=>{e.preventDefault();clearMessage();if(!el.run.value||!el.nextStep.value){showMessage("Choose a running workflow and its next stage.","warning");return;}const {error}=await db.rpc("admin_advance_claim_workflow",{p_run_id:el.run.value,p_target_step_id:el.nextStep.value,p_note:el.advanceNote.value.trim()||null});if(error){showMessage(errorText(error),"error");return;}el.advanceNote.value="";await loadData();showMessage("Workflow advanced by one stage. Any customer-visible update was added to the case timeline.");});
  el.refresh.addEventListener("click",loadData);el.signOut.addEventListener("click",async()=>{await db.auth.signOut();window.location.assign("../login.html");});
  (async()=>{if(await guard())await loadData();})();
})();
