(() => {
  "use strict";

  const CFG = window.CONTAS_CONFIG;
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  const MAX_FILE_MB = 10;
  const LS = { origem: "contas.origemFiltro", lastOrigem: "contas.ultimaOrigem", lastTipo: "contas.ultimoTipo", pdf: "contas.pdfOrigem", visao: "contas.visao" };

  // ---------------------------------------------------------------- estado
  const state = {
    user: null,
    month: currentMonthKey(),   // "AAAA-MM"
    contas: [],
    filter: "todas",
    origem: lsGet(LS.origem),   // filtro de origem ("" = todas)
    busca: "",
    abertos: new Set((() => { try { return JSON.parse(lsGet("contas.gruposAbertos") || "[]"); } catch { return []; } })()),
    editing: null,              // conta em edição (ou null)
    removeNota: false,
    origemTocada: false,        // usuário escolheu a origem à mão neste formulário
    hist: { origens: [], porDescricao: new Map(), descricoes: [] },
    perfil: null,               // papel do usuário logado: admin ou leitor
    visao: "minhas"             // "minhas" = contas da própria pessoa; "compartilhadas" = origens liberadas por outra pessoa
  };

  // ---------------------------------------------------------------- utilitários
  const $ = (sel) => document.querySelector(sel);
  const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

  function lsGet(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v || ""); } catch {} }
  function pad(n) { return String(n).padStart(2, "0"); }
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function currentMonthKey() { return todayStr().slice(0, 7); }
  function monthToDb(key) { return `${key}-01`; }
  function shiftMonthKey(key, n) {
    const [y, m] = key.split("-").map(Number);
    const d = new Date(y, m - 1 + n, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }
  // soma n meses a "AAAA-MM-DD", ajustando o dia ao fim do mês (31/01 + 1 = 28/02)
  function addMonthsDate(str, n) {
    if (!str) return null;
    const [y, m, d] = str.split("-").map(Number);
    const target = new Date(y, m - 1 + n, 1);
    const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(Math.min(d, last))}`;
  }
  function monthLabel(key) {
    const [y, m] = key.split("-").map(Number);
    const t = new Date(y, m - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function fmtDate(str) {
    if (!str) return "";
    const [, m, d] = str.split("-");
    return `${d}/${m}`;
  }
  function parseValor(txt) {
    let s = String(txt || "").replace(/[R$\s]/g, "");
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  }
  function valorToInput(n) {
    return Number(n).toFixed(2).replace(".", ",");
  }
  function norm(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function safeFileName(name) {
    const base = name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "_");
    return base.slice(-80) || "arquivo";
  }
  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function friendlyError(err) {
    const msg = (err && (err.message || err.error_description)) || String(err);
    if (/Invalid login credentials/i.test(msg)) return "E-mail ou senha incorretos.";
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return "Sem conexão com o servidor. Verifique a internet.";
    if (/JWT|expired/i.test(msg)) return "Sua sessão expirou. Entre novamente.";
    return msg;
  }

  // ---------------------------------------------------------------- autenticação
  async function init() {
    const { data } = await sb.auth.getSession();
    setUser(data.session?.user || null);
    sb.auth.onAuthStateChange((_event, session) => setTimeout(() => setUser(session?.user || null), 0));
  }

  function setUser(user) {
    const changed = (user?.id || null) !== (state.user?.id || null);
    state.user = user;
    $("#view-login").hidden = !!user;
    $("#view-app").hidden = !user;
    if (user && changed) loadPerfil().then(() => { loadMonth(); loadHistory(); });
    if (!user) { state.contas = []; state.perfil = null; state.visao = "minhas"; aplicarPapel(); render(); }
  }

  // quem pode ter as próprias contas: o administrador, quem não tem perfil (instalação antiga)
  // e o leitor que o administrador liberou para controlar as próprias contas
  const temProprias = () => !state.perfil || state.perfil.papel === "admin" || !!state.perfil.controla_proprias;
  // quem recebeu origens de outra pessoa para ver (somente leitura)
  const temCompartilhadas = () => state.perfil?.papel === "leitor" && (state.perfil.origens || []).length > 0;
  // edita só nas próprias contas; o que foi compartilhado é sempre somente leitura
  const somenteLeitura = () => state.visao !== "minhas" || !temProprias();

  async function loadPerfil() {
    const { data } = await sb.from("perfis").select("*").eq("id", state.user.id).maybeSingle();
    state.perfil = data || null;
    const salva = lsGet(`${LS.visao}.${state.user.id}`);
    if (!temProprias()) state.visao = "compartilhadas";
    else if (!temCompartilhadas()) state.visao = "minhas";
    else state.visao = salva === "compartilhadas" ? "compartilhadas" : "minhas";
    aplicarPapel();
  }
  function aplicarPapel() {
    const ro = somenteLeitura();
    document.body.classList.toggle("leitor", ro);
    $("#add-btn").hidden = ro;
    $("#copy-monthly").hidden = ro;
    $("#open-users").hidden = state.perfil?.papel !== "admin";
    const duas = !!state.user && temProprias() && temCompartilhadas();
    $("#visao-seg").hidden = !duas;
    document.querySelectorAll("#visao-seg button").forEach((b) => b.classList.toggle("active", b.dataset.visao === state.visao));
    const tag = $("#modo-leitura");
    tag.hidden = !ro || !state.user;
    tag.textContent = !ro ? "" : (duas
      ? "Contas compartilhadas com você, em modo somente leitura."
      : `Olá, ${state.perfil?.nome || ""}! Você está vendo as contas em modo somente leitura.`);
  }

  // filtra pela visão: as minhas (user_id = eu) ou as que outra pessoa compartilhou
  function daVisao(q) {
    return state.visao === "minhas" ? q.eq("user_id", state.user.id) : q.neq("user_id", state.user.id);
  }

  $("#visao-seg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-visao]");
    if (!b || b.dataset.visao === state.visao) return;
    state.visao = b.dataset.visao;
    lsSet(`${LS.visao}.${state.user.id}`, state.visao);
    state.origem = "";
    lsSet(LS.origem, "");
    state.contas = [];
    state.hist = { origens: [], porDescricao: new Map(), descricoes: [] };
    aplicarPapel();
    loadMonth();
    loadHistory();
  });

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const btn = f.querySelector("button[type=submit]");
    const errEl = $("#login-error");
    errEl.hidden = true;
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({
      email: f.email.value.trim(),
      password: f.password.value
    });
    btn.disabled = false;
    if (error) { errEl.textContent = friendlyError(error); errEl.hidden = false; return; }
    f.password.value = "";
  });

  $("#logout").addEventListener("click", async () => {
    closeMenu();
    await sb.auth.signOut();
  });

  // ---------------------------------------------------------------- dados
  async function loadMonth() {
    $("#month-label").textContent = monthLabel(state.month);
    $("#month-picker").value = state.month;
    const visao = state.visao, mes = state.month;
    const { data, error } = await daVisao(sb
      .from("contas")
      .select("*")
      .eq("mes_referencia", monthToDb(state.month)))
      .order("descricao", { ascending: true });
    if (visao !== state.visao || mes !== state.month) return; // trocou de visão ou de mês no meio da busca
    if (error) { toast(friendlyError(error)); return; }
    state.contas = data || [];
    render();
  }

  // histórico para sugestões: origens mais usadas e o último lançamento de cada descrição
  async function loadHistory() {
    const visao = state.visao;
    const { data, error } = await daVisao(sb
      .from("contas")
      .select("descricao, valor, tipo, origem, total_parcelas, created_at, mes_referencia"))
      .order("mes_referencia", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(3000);
    if (error || !data || visao !== state.visao) return;
    const freq = new Map();
    const porDescricao = new Map();
    for (const c of data) {
      if (c.origem) freq.set(c.origem, (freq.get(c.origem) || 0) + 1);
      const k = norm(c.descricao);
      if (k && !porDescricao.has(k)) porDescricao.set(k, c);
    }
    state.hist.origens = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([o]) => o);
    state.hist.porDescricao = porDescricao;
    state.hist.descricoes = [...porDescricao.values()].map((c) => c.descricao);
    $("#descricoes").innerHTML = state.hist.descricoes.map((d) => `<option value="${esc(d)}">`).join("");
    $("#origens").innerHTML = state.hist.origens.map((o) => `<option value="${esc(o)}">`).join("");
    render();
  }

  function isOverdue(c) {
    return !c.pago && c.vencimento && c.vencimento < todayStr();
  }
  // parcela 1 = compra parcelada que entrou neste mês
  function isNova(c) { return c.tipo === "parcelado" && c.parcela_atual === 1; }

  function origensDisponiveis() {
    const set = new Set(state.hist.origens);
    state.contas.forEach((c) => c.origem && set.add(c.origem));
    const lista = [...set];
    if (state.origem && !set.has(state.origem)) lista.unshift(state.origem);
    return lista;
  }

  function renderOrigemTabs() {
    // só as origens que têm contas no mês aberto, das mais usadas para as menos usadas
    const noMes = new Set(state.contas.map((c) => c.origem).filter(Boolean));
    const pos = (o) => { const i = state.hist.origens.indexOf(o); return i < 0 ? 9999 : i; };
    const lista = [...noMes].sort((a, b) => pos(a) - pos(b) || a.localeCompare(b, "pt-BR"));
    // a origem filtrada continua visível (e marcada) mesmo sem contas no mês, para dar para desmarcar
    if (state.origem && !noMes.has(state.origem)) lista.push(state.origem);
    const tabs = [["", "Todas"], ...lista.map((o) => [o, o])];
    $("#origem-tabs").innerHTML = tabs.map(([v, label]) =>
      `<button type="button" class="chip${state.origem === v ? " active" : ""}${v && !noMes.has(v) ? " dim" : ""}" data-origem="${esc(v)}">${esc(label)}</button>`
    ).join("");
  }

  const GRUPOS = [
    { titulo: "Parceladas", tipos: ["parcelado"] },
    { titulo: "Mensais", tipos: ["mensal"] },
    { titulo: "Avulsos", tipos: ["avulso", "avista"] }
  ];

  function render() {
    renderOrigemTabs();
    const doMes = state.contas;
    const all = state.origem ? doMes.filter((c) => (c.origem || "") === state.origem) : doMes;

    const total = all.reduce((s, c) => s + Number(c.valor), 0);
    const pago = all.filter((c) => c.pago).reduce((s, c) => s + Number(c.valor), 0);
    $("#sum-label").textContent = state.origem ? `Total · ${state.origem}` : "Total do mês";
    $("#sum-total").textContent = brl.format(total);
    $("#sum-paid").textContent = brl.format(pago);
    $("#sum-open").textContent = brl.format(total - pago);
    $("#progress-bar").style.width = total > 0 ? `${Math.round((pago / total) * 100)}%` : "0%";

    let rows = all;
    if (state.filter === "abertas") rows = rows.filter((c) => !c.pago);
    if (state.filter === "pagas") rows = rows.filter((c) => c.pago);
    if (state.busca) { const q = norm(state.busca); rows = rows.filter((c) => norm(c.descricao).includes(q)); }

    const ordem = (a, b) =>
      Number(a.pago) - Number(b.pago) ||
      (a.data_compra || a.vencimento || "9").localeCompare(b.data_compra || b.vencimento || "9") ||
      a.descricao.localeCompare(b.descricao, "pt-BR");

    $("#empty").hidden = doMes.length > 0;
    const list = $("#list");
    if (all.length > 0 && rows.length === 0) {
      list.innerHTML = `<p class="empty">Nada por aqui neste filtro.</p>`;
      return;
    }
    list.innerHTML = GRUPOS.map((g) => {
      const itens = rows.filter((c) => g.tipos.includes(c.tipo)).sort(ordem);
      if (!itens.length) return "";
      const sub = itens.reduce((s, c) => s + Number(c.valor), 0);
      const aberto = state.abertos.has(g.titulo) || !!state.busca;
      const aPagar = itens.filter((c) => !c.pago).reduce((s, c) => s + Number(c.valor), 0);
      const novas = itens.filter(isNova).length;
      const nota = aPagar === 0 ? "tudo pago" : (aPagar < sub ? `a pagar ${brl.format(aPagar)}` : "");
      return `<section class="grupo${aberto ? " aberto" : ""}">
        <button type="button" class="grupo-head card" data-grupo="${g.titulo}" aria-expanded="${aberto}">
          <span class="grupo-tit"><span class="chev" aria-hidden="true">›</span>${g.titulo} <small>${itens.length}</small>${novas ? ` <span class="badge novo">${novas} ${novas > 1 ? "novas" : "nova"}</span>` : ""}</span>
          <span class="grupo-val">${brl.format(sub)}${nota ? `<small>${nota}</small>` : ""}</span>
        </button>
        ${aberto ? `<ul class="list-ul">${itens.map(itemHtml).join("")}</ul>` : ""}
      </section>`;
    }).join("");
  }

  const TIPO_LABEL = { avista: "À vista", parcelado: "Parcelado", mensal: "Mensal", avulso: "Avulso" };

  function itemHtml(c) {
    const meta = [];
    if (c.data_compra) meta.push(`<span>${fmtDate(c.data_compra)}</span>`);
    if (c.vencimento) {
      meta.push(isOverdue(c)
        ? `<span class="badge late">Venceu ${fmtDate(c.vencimento)}</span>`
        : `<span>Vence ${fmtDate(c.vencimento)}</span>`);
    }
    if (c.tipo === "parcelado" && c.parcela_atual && c.total_parcelas) {
      meta.push(`<span class="badge parcelado">${c.parcela_atual}/${c.total_parcelas}</span>`);
    }
    if (c.origem && !state.origem) meta.push(`<span>${esc(c.origem)}</span>`);
    if (c.nota_path) meta.push(`<span title="Tem nota fiscal">📎</span>`);

    const cls = ["card", "item", c.pago ? "paid" : "", isOverdue(c) ? "overdue" : ""].join(" ");
    return `
      <li class="${cls}" data-id="${c.id}">
        <button class="pay-toggle" data-action="toggle" aria-label="${c.pago ? "Marcar como não paga" : "Marcar como paga"}"><span>✓</span></button>
        <button class="item-main" data-action="edit">
          <div class="item-title">${isNova(c) ? `<span class="badge novo">Novo</span> ` : ""}${esc(c.descricao)}</div>
          <div class="item-meta">${meta.join("")}</div>
        </button>
        <div class="item-value">${brl.format(Number(c.valor))}</div>
      </li>`;
  }

  $("#list").addEventListener("click", async (e) => {
    const grupo = e.target.closest("[data-grupo]");
    if (grupo) {
      const t = grupo.dataset.grupo;
      if (state.abertos.has(t)) state.abertos.delete(t); else state.abertos.add(t);
      lsSet("contas.gruposAbertos", JSON.stringify([...state.abertos]));
      render();
      return;
    }
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.closest("li").dataset.id;
    const conta = state.contas.find((c) => c.id === id);
    if (!conta) return;
    if (btn.dataset.action === "edit") openForm(conta);
    if (btn.dataset.action === "toggle" && !somenteLeitura()) togglePago(conta);
  });

  async function togglePago(conta) {
    const pago = !conta.pago;
    const patch = { pago, data_pagamento: pago ? todayStr() : null };
    Object.assign(conta, patch);       // atualiza na hora
    render();
    const { error } = await sb.from("contas").update(patch).eq("id", conta.id);
    if (error) { toast(friendlyError(error)); loadMonth(); }
  }

  // ---------------------------------------------------------------- navegação e filtros
  $("#prev-month").addEventListener("click", () => { state.month = shiftMonthKey(state.month, -1); loadMonth(); });
  $("#next-month").addEventListener("click", () => { state.month = shiftMonthKey(state.month, 1); loadMonth(); });
  $("#month-label").addEventListener("click", () => {
    const p = $("#month-picker");
    try { p.showPicker(); }
    catch {
      const v = prompt("Ir para o mês (AAAA-MM):", state.month);
      if (v && /^\d{4}-\d{2}$/.test(v)) { state.month = v; loadMonth(); }
    }
  });
  $("#month-picker").addEventListener("change", (e) => {
    if (e.target.value) { state.month = e.target.value; loadMonth(); }
  });

  $("#origem-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-origem]");
    if (!b) return;
    state.origem = b.dataset.origem;
    lsSet(LS.origem, state.origem);
    render();
  });

  document.querySelectorAll(".filters .chip").forEach((chip) => chip.addEventListener("click", () => {
    document.querySelectorAll(".filters .chip").forEach((c) => c.classList.toggle("active", c === chip));
    state.filter = chip.dataset.filter;
    render();
  }));
  $("#busca").addEventListener("input", (e) => { state.busca = e.target.value; render(); });

  // ---------------------------------------------------------------- menu
  function closeMenu() { $("#menu").hidden = true; }
  $("#menu-btn").addEventListener("click", (e) => { e.stopPropagation(); $("#menu").hidden = !$("#menu").hidden; });
  document.addEventListener("click", (e) => { if (!e.target.closest("#menu")) closeMenu(); });

  $("#copy-monthly").addEventListener("click", async () => {
    closeMenu();
    const prev = shiftMonthKey(state.month, -1);
    if (somenteLeitura()) return;
    const { data, error } = await sb.from("contas").select("*")
      .eq("user_id", state.user.id)
      .eq("mes_referencia", monthToDb(prev)).eq("tipo", "mensal");
    if (error) { toast(friendlyError(error)); return; }
    const existentes = new Set(state.contas.map((c) => norm(c.descricao)));
    const novas = (data || [])
      .filter((c) => !existentes.has(norm(c.descricao)))
      .map((c) => ({
        descricao: c.descricao, valor: c.valor, tipo: "mensal", origem: c.origem, observacao: null,
        mes_referencia: monthToDb(state.month),
        vencimento: addMonthsDate(c.vencimento, 1),
        data_compra: null,
        pago: false
      }));
    if (!novas.length) { toast("Nenhuma conta mensal nova para trazer."); return; }
    const nomes = novas.map((c) => `• ${c.descricao} (${brl.format(Number(c.valor))})`).join("\n");
    if (!confirm(`Lançar em ${monthLabel(state.month)} estas contas mensais de ${monthLabel(prev)}?\n\n${nomes}`)) return;
    const { error: e2 } = await sb.from("contas").insert(novas);
    if (e2) { toast(friendlyError(e2)); return; }
    toast(`${novas.length} conta(s) mensal(is) lançada(s).`);
    loadMonth();
  });

  $("#export-csv").addEventListener("click", () => {
    closeMenu();
    const cols = ["descricao", "valor", "data_compra", "vencimento", "tipo", "parcela_atual", "total_parcelas", "origem", "pago", "data_pagamento", "observacao"];
    const cell = (v) => {
      if (v === null || v === undefined) return "";
      if (typeof v === "boolean") return v ? "sim" : "não";
      if (typeof v === "number") return String(v).replace(".", ",");
      const s = String(v);
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = state.origem ? state.contas.filter((c) => c.origem === state.origem) : state.contas;
    const lines = [cols.join(";")].concat(rows.map((c) => cols.map((k) => cell(k === "valor" ? Number(c[k]) : c[k])).join(";")));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `contas_${state.month}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // ---------------------------------------------------------------- formulário
  const dlg = $("#form-dialog");
  const form = $("#conta-form");

  function setTipo(tipo) {
    if (tipo === "avista") tipo = "avulso";
    form.tipo.value = tipo;
    document.querySelectorAll("#tipo-seg button").forEach((b) => b.classList.toggle("active", b.dataset.tipo === tipo));
    const parcelado = tipo === "parcelado";
    $("#parcelas-row").hidden = !parcelado;
    $("#gerar-row").hidden = !parcelado || !!state.editing;
    if (parcelado && !form.parcela_atual.value) form.parcela_atual.value = 1;
  }
  $("#tipo-seg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tipo]");
    if (b) setTipo(b.dataset.tipo);
  });

  function renderOrigemChips() {
    const top = state.hist.origens.slice(0, 8);
    const atual = form.origem.value.trim();
    if (atual && !top.includes(atual)) top.unshift(atual);
    $("#origem-chips").innerHTML = top.map((o) =>
      `<button type="button" class="chip${o === atual ? " active" : ""}" data-origem="${esc(o)}">${esc(o)}</button>`
    ).join("") || `<span class="muted small">As origens que você usar aparecem aqui.</span>`;
  }
  $("#origem-chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-origem]");
    if (!b) return;
    form.origem.value = form.origem.value === b.dataset.origem ? "" : b.dataset.origem;
    state.origemTocada = true;
    renderOrigemChips();
  });
  form.origem.addEventListener("input", () => { state.origemTocada = true; renderOrigemChips(); });

  // ao escolher uma descrição já usada, completa o resto com o último lançamento dela
  function autoPreencher() {
    if (state.editing) return;
    const ult = state.hist.porDescricao.get(norm(form.descricao.value));
    if (!ult) return;
    if (!form.valor.value) form.valor.value = valorToInput(ult.valor);
    if (ult.origem && !state.origemTocada) { form.origem.value = ult.origem; renderOrigemChips(); }
    setTipo(ult.tipo);
    if (ult.tipo === "parcelado" && ult.total_parcelas && !form.total_parcelas.value) form.total_parcelas.value = ult.total_parcelas;
  }
  form.descricao.addEventListener("change", autoPreencher);
  form.descricao.addEventListener("input", () => {
    // escolha pela lista de sugestões dispara "input" com o texto completo
    if (state.hist.porDescricao.has(norm(form.descricao.value))) autoPreencher();
  });

  form.nota.addEventListener("change", () => {
    const f = form.nota.files[0];
    $("#nota-label").textContent = f ? `📎 ${f.name}` : "📎 Anexar nota fiscal";
  });

  function openForm(conta = null, manter = null) {
    state.editing = conta;
    state.removeNota = false;
    state.origemTocada = false;
    form.reset();
    $("#nota-label").textContent = "📎 Anexar nota fiscal";
    $("#form-error").hidden = true;
    $("#form-title").textContent = conta ? "Editar conta" : "Nova conta";
    $("#form-delete").hidden = !conta;
    $("#form-save-next").hidden = !!conta;
    $("#mais-opcoes").open = false;

    if (conta) {
      form.descricao.value = conta.descricao;
      form.valor.value = valorToInput(conta.valor);
      form.vencimento.value = conta.vencimento || "";
      form.data_compra.value = conta.data_compra || "";
      form.mes_referencia.value = conta.mes_referencia.slice(0, 7);
      form.parcela_atual.value = conta.parcela_atual || "";
      form.total_parcelas.value = conta.total_parcelas || "";
      form.origem.value = conta.origem || "";
      form.pago.checked = conta.pago;
      form.observacao.value = conta.observacao || "";
      state.origemTocada = true;
      setTipo(conta.tipo);
      if (conta.vencimento || conta.observacao || conta.mes_referencia.slice(0, 7) !== state.month) $("#mais-opcoes").open = true;
    } else {
      // padrões: origem do filtro ou a última usada, tipo da última conta, data de hoje, mês aberto
      form.origem.value = manter?.origem ?? (state.origem || lsGet(LS.lastOrigem));
      form.data_compra.value = manter?.data_compra || todayStr();
      form.mes_referencia.value = manter?.mes || state.month;
      setTipo(manter?.tipo || lsGet(LS.lastTipo) || "avulso");
      if (form.tipo.value === "parcelado") form.total_parcelas.value = "";
    }
    $("#nota-atual").hidden = !(conta && conta.nota_path);
    renderOrigemChips();
    // somente leitura: só visualiza (e abre a nota fiscal)
    const ro = somenteLeitura();
    form.querySelectorAll("input, select, textarea, #tipo-seg button, #origem-chips button").forEach((el) => { el.disabled = ro; });
    form.querySelector(".sheet-foot").hidden = ro;
    form.querySelector(".file-btn").hidden = ro;
    $("#nota-remover").hidden = ro;
    if (ro) { $("#form-title").textContent = "Detalhe"; $("#mais-opcoes").open = true; }
    if (!dlg.open) dlg.showModal();
    if (!conta) setTimeout(() => form.valor.focus(), 60);
  }

  $("#add-btn").addEventListener("click", () => { if (!somenteLeitura()) openForm(null); });
  $("#form-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });

  $("#nota-ver").addEventListener("click", () => openNota(state.editing?.nota_path));
  $("#nota-remover").addEventListener("click", () => {
    state.removeNota = true;
    $("#nota-atual").hidden = true;
    toast("A nota será removida ao salvar.");
  });

  function formError(msg) {
    const el = $("#form-error");
    el.textContent = msg;
    el.hidden = false;
  }

  async function salvar(lancarOutra) {
    $("#form-error").hidden = true;

    const valor = parseValor(form.valor.value);
    if (!Number.isFinite(valor) || valor <= 0) return formError("Informe um valor válido, por exemplo 150,90.");
    if (!form.descricao.value.trim()) return formError("Informe a descrição.");
    if (!form.mes_referencia.value) return formError("Informe o mês de referência em Mais opções.");

    const tipo = form.tipo.value;
    const ed = state.editing;
    const pago = form.pago.checked;
    const base = {
      descricao: form.descricao.value.trim(),
      valor,
      vencimento: form.vencimento.value || null,
      data_compra: form.data_compra.value || null,
      mes_referencia: monthToDb(form.mes_referencia.value),
      tipo,
      parcela_atual: tipo === "parcelado" ? (parseInt(form.parcela_atual.value, 10) || null) : null,
      total_parcelas: tipo === "parcelado" ? (parseInt(form.total_parcelas.value, 10) || null) : null,
      origem: form.origem.value.trim() || null,
      pago,
      // data do pagamento: automática ao marcar como pago (mantém a anterior se já estava pago)
      data_pagamento: pago ? ((ed && ed.pago && ed.data_pagamento) || todayStr()) : null,
      observacao: form.observacao.value.trim() || null
    };
    if (tipo === "parcelado") {
      if (!base.parcela_atual || !base.total_parcelas) return formError("Informe a parcela atual e o total de parcelas.");
      if (base.parcela_atual > base.total_parcelas) return formError("A parcela atual não pode ser maior que o total.");
    }

    const file = form.nota.files[0] || null;
    if (file && file.size > MAX_FILE_MB * 1024 * 1024) return formError(`O arquivo passa de ${MAX_FILE_MB} MB.`);

    const btns = [$("#form-save"), $("#form-save-next")];
    btns.forEach((b) => (b.disabled = true));
    $("#form-save").textContent = "Salvando...";
    try {
      let conta;
      let qtd = 1;
      if (ed) {
        const { data, error } = await sb.from("contas").update(base).eq("id", ed.id).select().single();
        if (error) throw error;
        conta = data;
      } else {
        const rows = [base];
        if (tipo === "parcelado" && form.gerar_parcelas.checked) {
          for (let p = base.parcela_atual + 1, k = 1; p <= base.total_parcelas; p++, k++) {
            rows.push({
              ...base,
              parcela_atual: p,
              mes_referencia: addMonthsDate(base.mes_referencia, k),
              vencimento: addMonthsDate(base.vencimento, k),
              pago: false,
              data_pagamento: null
            });
          }
        }
        const { data, error } = await sb.from("contas").insert(rows).select();
        if (error) throw error;
        conta = data[0];
        qtd = rows.length;
        lsSet(LS.lastOrigem, base.origem);
        lsSet(LS.lastTipo, tipo);
      }

      // nota fiscal
      const oldPath = ed?.nota_path || null;
      if (file) {
        const path = `${state.user.id}/${conta.id}/${Date.now()}_${safeFileName(file.name)}`;
        const { error: upErr } = await sb.storage.from(CFG.bucket).upload(path, file, {
          contentType: file.type || "application/octet-stream", upsert: false
        });
        if (upErr) throw upErr;
        const { error: e2 } = await sb.from("contas").update({ nota_path: path }).eq("id", conta.id);
        if (e2) throw e2;
        if (oldPath) await sb.storage.from(CFG.bucket).remove([oldPath]);
      } else if (state.removeNota && oldPath) {
        await sb.storage.from(CFG.bucket).remove([oldPath]);
        await sb.from("contas").update({ nota_path: null }).eq("id", conta.id);
      }

      toast(qtd > 1 ? `${qtd} parcelas lançadas.` : (ed ? "Alterado." : "Lançado."));
      const mes = base.mes_referencia.slice(0, 7);
      if (lancarOutra) {
        openForm(null, { origem: base.origem || "", tipo, data_compra: base.data_compra, mes });
      } else {
        dlg.close();
        if (mes !== state.month) state.month = mes;
      }
      await loadMonth();
      loadHistory();
    } catch (err) {
      formError(friendlyError(err));
    } finally {
      btns.forEach((b) => (b.disabled = false));
      $("#form-save").textContent = "Salvar";
    }
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); salvar(false); });
  $("#form-save-next").addEventListener("click", () => salvar(true));

  $("#form-delete").addEventListener("click", async () => {
    const c = state.editing;
    if (!c) return;
    if (!confirm(`Excluir "${c.descricao}"?`)) return;
    if (c.nota_path) await sb.storage.from(CFG.bucket).remove([c.nota_path]);
    const { error } = await sb.from("contas").delete().eq("id", c.id);
    if (error) return formError(friendlyError(error));
    dlg.close();
    toast("Conta excluída.");
    loadMonth();
  });

  async function openNota(path) {
    if (!path) return;
    // abre a janela antes do await para o Safari não bloquear como pop-up
    const w = window.open("", "_blank");
    const { data, error } = await sb.storage.from(CFG.bucket).createSignedUrl(path, 120);
    if (error) { if (w) w.close(); toast(friendlyError(error)); return; }
    if (w) w.location.href = data.signedUrl;
    else window.location.href = data.signedUrl;
  }

  // ---------------------------------------------------------------- usuários (somente administrador)
  const usersDlg = $("#users-dialog");
  const userForm = $("#user-form");
  let usuarios = [];

  function origemChecks(sel) {
    return state.hist.origens.map((o) =>
      `<label class="chk-chip"><input type="checkbox" value="${esc(o)}"${sel.includes(o) ? " checked" : ""}><span>${esc(o)}</span></label>`
    ).join("") || `<span class="muted small">Nenhuma origem cadastrada ainda.</span>`;
  }
  function marcadas(el) { return [...el.querySelectorAll("input[type=checkbox]:checked")].map((i) => i.value); }

  async function chamarFuncao(body) {
    const { data, error } = await sb.functions.invoke("usuarios", { body });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); if (j?.error || j?.message || j?.msg) msg = j.error || j.message || j.msg; } catch {}
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function loadUsuarios() {
    const { data, error } = await sb.from("perfis").select("*").eq("dono", state.user.id).order("created_at");
    if (error) { toast(friendlyError(error)); return; }
    usuarios = data || [];
    $("#users-list").innerHTML = usuarios.length ? usuarios.map((u) => `
      <div class="card user-card" data-id="${u.id}">
        <div class="user-top"><strong>${esc(u.nome || u.email)}</strong><span class="muted small">${esc(u.email || "")}</span></div>
        <label class="check"><input type="checkbox" class="proprias"${u.controla_proprias ? " checked" : ""}> Controla as próprias contas</label>
        <span class="flabel">Pode ver das suas origens</span>
        <div class="chips-wrap origens-wrap">${origemChecks(u.origens || [])}</div>
        <div class="user-actions">
          <button type="button" class="btn" data-acao="salvar">Salvar acesso</button>
          <button type="button" class="link" data-acao="senha">Trocar senha</button>
          <button type="button" class="link danger" data-acao="excluir">Excluir</button>
        </div>
      </div>`).join("") : `<p class="muted small">Ainda não há outros usuários.</p>`;
  }

  $("#open-users").addEventListener("click", async () => {
    closeMenu();
    userForm.reset();
    $("#user-error").hidden = true;
    $("#user-origens").innerHTML = origemChecks(state.origem ? [state.origem] : []);
    usersDlg.showModal();
    await loadUsuarios();
  });
  $("#users-close").addEventListener("click", () => usersDlg.close());
  usersDlg.addEventListener("click", (e) => { if (e.target === usersDlg) usersDlg.close(); });

  userForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#user-error");
    err.hidden = true;
    const origens = marcadas($("#user-origens"));
    const proprias = userForm.proprias.checked;
    if (!origens.length && !proprias) {
      err.textContent = "Marque \"Controla as próprias contas\" ou pelo menos uma origem que essa pessoa pode ver.";
      err.hidden = false; return;
    }
    const btn = $("#user-create");
    btn.disabled = true; btn.textContent = "Criando...";
    try {
      const r = await chamarFuncao({ acao: "criar", nome: userForm.nome.value.trim(), email: userForm.email.value.trim(), senha: userForm.senha.value, origens, proprias });
      if (proprias && r?.id) {
        const { error } = await sb.from("perfis").update({ controla_proprias: true }).eq("id", r.id);
        if (error) throw new Error("Usuário criado, mas não deu para liberar as contas próprias. Marque a opção no cartão dele e toque em Salvar acesso.");
      }
      toast("Usuário criado. Passe o e-mail e a senha para a pessoa.");
      userForm.reset();
      $("#user-origens").innerHTML = origemChecks([]);
      await loadUsuarios();
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = "Criar usuário";
    }
  });

  $("#users-list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-acao]");
    if (!b) return;
    const card = b.closest("[data-id]");
    const id = card.dataset.id;
    const u = usuarios.find((x) => x.id === id);
    const quem = u?.nome || u?.email || "este usuário";
    try {
      if (b.dataset.acao === "salvar") {
        const origens = marcadas(card.querySelector(".origens-wrap"));
        const proprias = card.querySelector(".proprias").checked;
        if (!origens.length && !proprias) { toast("Marque as contas próprias ou pelo menos uma origem."); return; }
        const { error } = await sb.from("perfis").update({ origens, controla_proprias: proprias }).eq("id", id);
        if (error) throw error;
        toast("Acesso atualizado.");
      } else if (b.dataset.acao === "senha") {
        const senha = prompt(`Nova senha para ${quem} (mínimo 8 caracteres):`);
        if (!senha) return;
        await chamarFuncao({ acao: "senha", id, senha });
        toast("Senha alterada.");
      } else if (b.dataset.acao === "excluir") {
        if (!confirm(`Excluir o acesso de ${quem}? As suas contas não são afetadas.`)) return;
        await chamarFuncao({ acao: "excluir", id });
        toast("Usuário excluído.");
        await loadUsuarios();
      }
    } catch (ex) {
      toast(friendlyError(ex));
    }
  });

  // ---------------------------------------------------------------- PDF para enviar
  const pdfDlg = $("#pdf-dialog");
  const pdfForm = $("#pdf-form");

  function pdfRows() {
    const origem = pdfForm.origem.value;
    let rows = state.contas.filter((c) => !origem || (c.origem || "") === origem);
    if (pdfForm.so_abertas.checked) rows = rows.filter((c) => !c.pago);
    return rows;
  }
  function updatePdfPreview() {
    const rows = pdfRows();
    const total = rows.reduce((s, c) => s + Number(c.valor), 0);
    $("#pdf-preview").textContent = `${rows.length} conta(s) · ${brl.format(total)}`;
  }

  $("#open-pdf").addEventListener("click", () => {
    closeMenu();
    const origens = [...new Set(state.contas.map((c) => c.origem).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    const saved = lsGet(LS.pdf);
    const sel = $("#pdf-origem");
    sel.innerHTML = `<option value="">Todas as origens</option>` +
      origens.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
    sel.value = origens.includes(state.origem) ? state.origem : (origens.includes(saved) ? saved : "");
    $("#pdf-month").textContent = `Referência: ${monthLabel(state.month)}`;
    $("#pdf-error").hidden = true;
    updatePdfPreview();
    pdfDlg.showModal();
  });
  $("#pdf-close").addEventListener("click", () => pdfDlg.close());
  pdfDlg.addEventListener("click", (e) => { if (e.target === pdfDlg) pdfDlg.close(); });
  pdfForm.origem.addEventListener("change", updatePdfPreview);
  pdfForm.so_abertas.addEventListener("change", updatePdfPreview);

  let jsPdfPromise;
  function loadJsPdf() {
    if (window.jspdf) return Promise.resolve(window.jspdf);
    jsPdfPromise ||= new Promise((resolve, reject) => {
      const sc = document.createElement("script");
      sc.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      sc.onload = () => resolve(window.jspdf);
      sc.onerror = () => { jsPdfPromise = null; reject(new Error("Não foi possível carregar o gerador de PDF. Verifique a internet.")); };
      document.head.appendChild(sc);
    });
    return jsPdfPromise;
  }

  function buildPdf(jsPDF, rows, origem) {
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const L = 18, R = 192, W = R - L;
    let y = 20;
    const money = (n) => brl.format(n);
    const ensure = (h) => { if (y + h > 280) { doc.addPage(); y = 20; } };

    doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.setTextColor(20, 32, 27);
    doc.text(`Contas - ${monthLabel(state.month)}`, L, y);
    y += 7;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(95, 109, 102);
    doc.text(`${origem ? "Origem: " + origem + "  ·  " : ""}Gerado em ${fmtDate(todayStr())}/${todayStr().slice(0, 4)}`, L, y);
    y += 8;

    function section(title, items, cols) {
      if (!items.length) return 0;
      ensure(22);
      doc.setFillColor(220, 227, 223); doc.rect(L, y - 5, W, 8, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(20, 32, 27);
      doc.text(title, L + 2, y);
      y += 8;
      doc.setFontSize(9); doc.setTextColor(95, 109, 102);
      cols.forEach((c) => doc.text(c.label, c.x, y, { align: c.align || "left" }));
      y += 2; doc.setDrawColor(200, 208, 204); doc.line(L, y, R, y); y += 5;
      doc.setFont("helvetica", "normal"); doc.setFontSize(10.5); doc.setTextColor(20, 32, 27);
      let sub = 0;
      items.forEach((c) => {
        ensure(7);
        cols.forEach((col) => {
          let v = col.get(c);
          if (col.max) v = doc.splitTextToSize(v, col.max)[0];
          doc.text(v, col.x, y, { align: col.align || "left" });
        });
        sub += Number(c.valor);
        y += 6.5;
      });
      ensure(9);
      doc.line(L, y - 3.5, R, y - 3.5);
      doc.setFont("helvetica", "bold");
      doc.text("Subtotal", L + 2, y + 1);
      doc.text(money(sub), 150, y + 1, { align: "right" });
      y += 11;
      return sub;
    }

    const byDate = (a, b) => ((a.data_compra || a.vencimento || "") < (b.data_compra || b.vencimento || "") ? -1 : 1);
    const parceladas = rows.filter((c) => c.tipo === "parcelado").sort((a, b) => a.descricao.localeCompare(b.descricao, "pt-BR"));
    const mensais = rows.filter((c) => c.tipo === "mensal").sort((a, b) => a.descricao.localeCompare(b.descricao, "pt-BR"));
    const avulsas = rows.filter((c) => c.tipo === "avista" || c.tipo === "avulso").sort(byDate);

    const desc = { label: "Descrição", x: L + 2, get: (c) => c.descricao, max: 100 };
    const valor = { label: "Valor", x: 150, align: "right", get: (c) => money(Number(c.valor)) };
    const status = { label: "Situação", x: R - 2, align: "right", get: (c) => (c.pago ? "Pago" : "A pagar") };

    section("Parceladas", parceladas, [
      desc, valor,
      { label: "Parcela", x: 172, align: "right", get: (c) => (c.parcela_atual && c.total_parcelas ? `${isNova(c) ? "Novo  " : ""}${c.parcela_atual}/${c.total_parcelas}` : "") },
      status
    ]);
    section("Mensais", mensais, [desc, valor, status]);
    section("Avulsos", avulsas, [
      { label: "Data", x: L + 2, get: (c) => fmtDate(c.data_compra || c.vencimento) || "-" },
      { label: "Descrição", x: L + 20, get: (c) => c.descricao, max: 85 },
      valor, status
    ]);

    const total = rows.reduce((s, c) => s + Number(c.valor), 0);
    ensure(14);
    doc.setFillColor(15, 81, 50); doc.rect(L, y - 6, W, 10, "F");
    doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(13);
    doc.text("TOTAL", L + 2, y + 0.5);
    doc.text(money(total), 150, y + 0.5, { align: "right" });
    return doc;
  }

  pdfForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rows = pdfRows();
    const errEl = $("#pdf-error");
    errEl.hidden = true;
    if (!rows.length) { errEl.textContent = "Nenhuma conta com esse filtro."; errEl.hidden = false; return; }
    const btn = $("#pdf-go");
    btn.disabled = true; btn.textContent = "Gerando...";
    try {
      const origem = pdfForm.origem.value;
      lsSet(LS.pdf, origem);
      const { jsPDF } = await loadJsPdf();
      const doc = buildPdf(jsPDF, rows, origem);
      const slug = (origem ? "_" + safeFileName(origem) : "");
      const name = `contas_${state.month}${slug}.pdf`;
      const blob = doc.output("blob");
      const file = new File([blob], name, { type: "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: name }); }
        catch (err) { if (err.name !== "AbortError") throw err; }
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      }
      pdfDlg.close();
    } catch (err) {
      errEl.textContent = friendlyError(err); errEl.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = "Gerar e compartilhar";
    }
  });

  // ---------------------------------------------------------------- PWA
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.user) loadMonth();
  });

  init();
})();
