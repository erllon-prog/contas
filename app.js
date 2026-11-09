(() => {
  "use strict";

  const CFG = window.CONTAS_CONFIG;

  // ---------------------------------------------------------------- núcleo comum (login, perfil, amigos, usuários, avisos)
  // Fica em ../comum/nucleo.js: o mesmo código do Média Flex. Mexeu lá, muda nos dois apps.
  const VERSAO = 12;
  const nucleo = Nucleo.iniciar({
    app: "contas",
    nome: "Contas",
    url: "https://erllon-prog.github.io/contas/",
    icone: "icons/icon-192.png",
    versao: VERSAO,
    descricao: "para controlar as contas a pagar e a receber",
    privacidade: "Pronto, só você vê as suas contas.",
    textoPrimeiraVez: "Primeira vez? É só entrar com o Google: sua conta é criada na hora e só você vê as suas contas.",
    rotuloProprias: "Controla as próprias contas",
    usuariosExtra: "Para alguém ver uma conta sua, vocês precisam ser amigos no app: aí é só escrever o @ da pessoa na origem.",
    amigosTexto: "Na origem de uma conta, escreva o @ de um amigo (ex.: <b>@josi</b>) para ele acompanhar essa conta em <b>A receber</b>, sem poder alterar. Origem sem @ só você vê.",
    conviteEnviadoTexto: "Convite enviado. Assim que a pessoa aceitar, ela aparece como origem.",
    novidades: {
      id: "contas-12",
      titulo: "O Contas foi atualizado",
      itens: [
        "Nada mudou nas suas contas: tudo continua igual e no mesmo lugar.",
        "Login, amigos e usuários agora são os mesmos do novo app <b>Média Flex</b> (consumo do carro, etanol x gasolina).",
        "Para conhecer, toque em <b>⋯ → Nossos apps</b>. Entra com o mesmo login."
      ],
      dica: "Se algo parecer estranho, feche o app e abra de novo. Quando sair outra versão, aparece um aviso com o botão Atualizar."
    },
    novidadesAlvo: ".content",
    aoEntrar,
    aoSair,
    aoMudarAmigos,
    aoVoltar: () => loadMonth(),
    antesDeSair: async () => {
      // saiu: este aparelho para de receber os avisos dessa pessoa (volta a receber se ela entrar de novo)
      const sub = await inscricaoDoAparelho();
      if (sub) await sb.rpc("remover_inscricao", { p_endpoint: sub.endpoint });
    }
  });
  const sb = nucleo.sb;

  const MAX_FILE_MB = 10;
  const LS = { origem: "contas.origemFiltro", lastOrigem: "contas.ultimaOrigem", lastTipo: "contas.ultimoTipo", pdf: "contas.pdfOrigem", visao: "contas.visao", avisoDias: "contas.avisoDias", avisoVisto: "contas.avisoVisto", instalarFechado: "contas.instalarFechado" };

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
    visao: "minhas",            // "minhas" = contas da própria pessoa; "receber" = contas em que um amigo marcou a pessoa com @
    amigos: [],                 // amizades e convites (função meus_amigos)
    alertas: [],                // contas que vencem logo (calculado no aparelho, nada vai para o banco)
    novos: []                   // pessoas que entraram sozinhas pelo link e esperam o administrador (só admin)
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
  function toast(msg) { nucleo.toast(msg); }
  function friendlyError(err) { return nucleo.friendlyError(err); }

  // ---------------------------------------------------------------- entrar e sair (o login em si fica no núcleo comum)
  function aoEntrar() {
    state.user = nucleo.user;
    state.perfil = nucleo.perfil;
    escolherVisao();
    loadMonth(); loadHistory(); sincronizarPush();
  }
  function aoSair() {
    state.user = null; state.contas = []; state.perfil = null; state.visao = "minhas";
    aplicarPapel(); render();
  }
  function aoMudarAmigos() {
    const visaoAntes = state.visao;
    escolherVisao();
    if (visaoAntes !== state.visao || state.visao === "receber") loadMonth();
  }

  // quem pode ter as próprias contas: o administrador, quem não tem perfil (instalação antiga)
  // e o leitor que o administrador liberou para controlar as próprias contas
  const temProprias = () => !state.perfil || state.perfil.papel === "admin" || !!state.perfil.controla_proprias;
  // amigos com convite aceito: só eles podem ser marcados com @ e só deles vêm contas "A receber"
  const amigosAceitos = () => nucleo.amigos.filter((a) => a.status === "aceita");
  const convitesRecebidos = () => nucleo.convitesRecebidos();
  const temReceber = () => amigosAceitos().length > 0;
  // só lança quem tem contas próprias; o que um amigo marcou para a pessoa é sempre somente leitura
  const somenteLeitura = () => !temProprias();
  const podeEditar = (c) => !c || (c.user_id === state.user?.id && temProprias());
  const nomeAmigo = (id) => { const a = nucleo.amigos.find((x) => x.amigo_id === id); return a ? a.nome : "Amigo"; };
  const amigoPorApelido = (txt) => {
    const m = /^@([a-z0-9_.]+)$/i.exec((txt || "").trim());
    return m ? amigosAceitos().find((a) => a.apelido === m[1].toLowerCase()) || null : undefined;
  };

  function escolherVisao() {
    const salva = lsGet(`${LS.visao}.${state.user.id}`);
    if (!temProprias()) state.visao = "receber";
    else state.visao = salva === "receber" ? "receber" : "minhas";
    aplicarPapel();
  }
  function aplicarPapel() {
    const ro = somenteLeitura();
    document.body.classList.toggle("leitor", ro);
    $("#add-btn").hidden = ro;
    $("#copy-monthly").hidden = ro;
    $("#open-users").hidden = state.perfil?.papel !== "admin";
    const duas = !!state.user && temProprias();
    $("#visao-seg").hidden = !duas;
    document.querySelectorAll("#visao-seg button").forEach((b) => b.classList.toggle("active", b.dataset.visao === state.visao));
    const receber = state.visao === "receber";
    $("#sum-open-label").textContent = receber ? "A receber" : "A pagar";
    $("#sum-paid-label").textContent = receber ? "Já pago a você" : "Pago";
    $("#filtro-abertas").textContent = receber ? "A receber" : "A pagar";
    $("#filtro-pagas").textContent = receber ? "Já pagas" : "Pagas";
    $("#empty").innerHTML = receber
      ? (temProprias() ? "Nada a receber neste mês. Toque em <b>+</b> para anotar quem está te devendo." : (temReceber() ? "Nenhum amigo marcou você em contas deste mês." : "Você ainda não tem amigos no app. Abra <b>⋯ → Amigos</b> para aceitar ou enviar um convite."))
      : "Nenhuma conta neste mês. Toque em <b>+</b> para lançar.";
    const tag = $("#modo-leitura");
    tag.hidden = !receber || !state.user;
    tag.textContent = !receber ? "" : (duas
      ? "Quem está te devendo: o que você anotou e as contas em que seus amigos marcaram você com @."
      : `Olá, ${state.perfil?.nome || ""}! Aqui aparecem as contas em que seus amigos marcaram você. Só eles podem alterar.`);
  }

  // filtra pela visão: as minhas (user_id = eu) ou as que um amigo marcou para mim
  function daVisao(q) {
    const eu = state.user.id;
    return state.visao === "minhas"
      ? q.eq("user_id", eu).eq("receber", false)
      : q.or(`and(user_id.eq.${eu},receber.eq.true),para_usuario.eq.${eu}`);
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
    state.contas = (data || []).map((c) => c.user_id !== state.user.id ? { ...c, origem_original: c.origem, origem: nomeAmigo(c.user_id), deAmigo: true } : c);
    render();
    loadAlertas();
  }

  // histórico para sugestões: origens mais usadas e o último lançamento de cada descrição
  async function loadHistory() {
    const visao = state.visao;
    if (!temProprias()) { state.hist = { origens: [], origensReceber: [], porDescricao: new Map(), descricoes: [] }; return; }
    const { data, error } = await sb
      .from("contas")
      .select("descricao, valor, tipo, origem, total_parcelas, created_at, mes_referencia, receber")
      .eq("user_id", state.user.id)
      .order("mes_referencia", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(3000);
    if (error || !data || visao !== state.visao) return;
    const freq = new Map();
    const freqReceber = new Map();
    const porDescricao = new Map();
    for (const c of data) {
      const f = c.receber ? freqReceber : freq;
      if (c.origem) f.set(c.origem, (f.get(c.origem) || 0) + 1);
      const k = norm(c.descricao);
      if (k && !porDescricao.has(k)) porDescricao.set(k, c);
    }
    state.hist.origens = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([o]) => o);
    state.hist.origensReceber = [...freqReceber.entries()].sort((a, b) => b[1] - a[1]).map(([o]) => o);
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
    const lista0 = state.visao === "receber" ? (state.hist.origensReceber || []) : state.hist.origens;
    const pos = (o) => { const i = lista0.indexOf(o); return i < 0 ? 9999 : i; };
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
    if (c.deAmigo) meta.push(`<span class="badge visivel" title="Lançado por ${esc(c.origem)}">👁 de amigo</span>`);
    if (c.para_usuario && state.visao === "minhas") meta.push(`<span class="badge visivel" title="${esc(nomeAmigo(c.para_usuario))} acompanha esta conta">👁 ${esc(nomeAmigo(c.para_usuario))}</span>`);
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
    if (btn.dataset.action === "toggle" && podeEditar(conta)) togglePago(conta);
  });

  async function togglePago(conta) {
    const pago = !conta.pago;
    const patch = { pago, data_pagamento: pago ? todayStr() : null };
    Object.assign(conta, patch);       // atualiza na hora
    render();
    const { error } = await sb.from("contas").update(patch).eq("id", conta.id);
    if (error) { toast(friendlyError(error)); loadMonth(); } else loadAlertas();
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
      .eq("user_id", state.user.id).eq("receber", state.visao === "receber")
      .eq("mes_referencia", monthToDb(prev)).eq("tipo", "mensal");
    if (error) { toast(friendlyError(error)); return; }
    const existentes = new Set(state.contas.map((c) => norm(c.descricao)));
    const novas = (data || [])
      .filter((c) => !existentes.has(norm(c.descricao)))
      .map((c) => ({
        descricao: c.descricao, valor: c.valor, tipo: "mensal", origem: c.origem, observacao: null, receber: !!c.receber,
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
  function setDirecao(receber) {
    form.receber.value = receber ? "1" : "0";
    document.querySelectorAll("#direcao-seg button").forEach((b) => b.classList.toggle("active", b.dataset.receber === form.receber.value));
    $("#origem-label").textContent = receber ? "Quem está te devendo" : "Origem";
    $("#pago-label").textContent = receber ? "Já recebi" : "Já está pago";
    form.origem.placeholder = receber ? "Nome de quem te deve" : "Ou digite outra origem (@ para um amigo)";
  }
  const ehReceber = () => form.receber.value === "1";
  $("#direcao-seg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-receber]");
    if (!b || b.disabled) return;
    setDirecao(b.dataset.receber === "1");
    renderOrigemChips();
  });

  $("#tipo-seg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tipo]");
    if (b) setTipo(b.dataset.tipo);
  });

  function renderOrigemChips() {
    const atual = form.origem.value.trim();
    const amigos = amigosAceitos().map((a) => "@" + a.apelido);
    let top;
    if (atual.startsWith("@")) {
      // digitando @: mostra só os amigos que combinam
      const q = atual.slice(1).toLowerCase();
      top = amigos.filter((o) => o.slice(1).startsWith(q) || norm(nomeAmigo(amigoPorApelido(o)?.amigo_id)).includes(norm(q)));
    } else if (ehReceber()) {
      top = (state.hist.origensReceber || []).slice(0, 8);
    } else {
      top = state.hist.origens.filter((o) => !o.startsWith("@")).slice(0, 8);
      amigos.forEach((o) => { if (!top.includes(o)) top.push(o); });
    }
    if (atual && atual !== "@" && !top.includes(atual)) top.unshift(atual);
    $("#origem-chips").innerHTML = top.map((o) => {
      const amg = o.startsWith("@") ? amigoPorApelido(o) : null;
      return `<button type="button" class="chip${o === atual ? " active" : ""}${amg ? " amigo" : ""}" data-origem="${esc(o)}"${amg ? ` title="${esc(amg.nome)}"` : ""}>${esc(o)}</button>`;
    }).join("") || `<span class="muted small">As origens que você usar aparecem aqui.</span>`;
    dicaOrigem();
  }
  function dicaOrigem() {
    const el = $("#origem-dica");
    const atual = form.origem.value.trim();
    const amg = amigoPorApelido(atual);
    el.hidden = !atual.startsWith("@") || somenteLeitura() || ehReceber();
    el.classList.toggle("erro", amg === null || amg === undefined);
    if (amg) el.textContent = `👁 ${amg.nome} vai acompanhar esta conta em "A receber", sem poder alterar.`;
    else if (amg === null) el.textContent = `${atual} não é seu amigo no app. Convide em ⋯ → Amigos ou tire o @.`;
    else el.textContent = "Depois do @ use só letras sem acento, números, ponto ou _.";
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
      setDirecao(!!conta.receber || !!conta.deAmigo);
      setTipo(conta.tipo);
      if (conta.vencimento || conta.observacao || conta.mes_referencia.slice(0, 7) !== state.month) $("#mais-opcoes").open = true;
    } else {
      // padrões: origem do filtro ou a última usada, tipo da última conta, data de hoje, mês aberto
      setDirecao(manter?.receber ?? state.visao === "receber");
      form.origem.value = manter?.origem ?? (state.origem || (ehReceber() ? "" : lsGet(LS.lastOrigem)));
      form.data_compra.value = manter?.data_compra || todayStr();
      form.mes_referencia.value = manter?.mes || state.month;
      setTipo(manter?.tipo || lsGet(LS.lastTipo) || "avulso");
      if (form.tipo.value === "parcelado") form.total_parcelas.value = "";
    }
    $("#nota-atual").hidden = !(conta && conta.nota_path);
    renderOrigemChips();
    // somente leitura: só visualiza (e abre a nota fiscal)
    const ro = contaRo(conta);
    form.querySelectorAll("input, select, textarea, #tipo-seg button, #direcao-seg button, #origem-chips button").forEach((el) => { el.disabled = ro; });
    form.querySelector(".sheet-foot").hidden = ro;
    form.querySelector(".file-btn").hidden = ro;
    $("#nota-remover").hidden = ro;
    if (ro) { $("#form-title").textContent = "Detalhe"; $("#mais-opcoes").open = true; }
    if (!dlg.open) dlg.showModal();
    if (!conta) setTimeout(() => form.valor.focus(), 60);
  }

  function contaRo(conta) { return conta ? !podeEditar(conta) : somenteLeitura(); }
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
      observacao: form.observacao.value.trim() || null,
      receber: ehReceber()
    };
    if (base.receber && !base.origem) return formError("Informe quem está te devendo.");
    if (!base.receber && base.origem && base.origem.startsWith("@")) {
      const amg = amigoPorApelido(base.origem);
      if (!amg) return formError(`${base.origem} não é seu amigo no app. Convide em ⋯ → Amigos ou escreva a origem sem o @.`);
      base.origem = "@" + amg.apelido;
    }
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
        if (!base.receber) lsSet(LS.lastOrigem, base.origem);
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
        openForm(null, { origem: base.origem || "", tipo, data_compra: base.data_compra, mes, receber: base.receber });
      } else {
        dlg.close();
        if (mes !== state.month) state.month = mes;
        const visaoCerta = base.receber ? "receber" : "minhas";
        if (state.visao !== visaoCerta) { state.visao = visaoCerta; lsSet(`${LS.visao}.${state.user.id}`, visaoCerta); aplicarPapel(); }
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


  // ---------------------------------------------------------------- avisos de vencimento (só no aparelho)
  const alertasDlg = $("#alertas-dialog");
  const diasAviso = () => Number(lsGet(LS.avisoDias)) || 3;
  function addDias(n) { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function diasAte(str) {
    const [y, m, d] = str.split("-").map(Number);
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    return Math.round((new Date(y, m - 1, d) - hoje) / 86400000);
  }
  function quandoTxt(n) {
    if (n < -1) return `venceu há ${-n} dias`;
    if (n === -1) return "venceu ontem";
    if (n === 0) return "vence hoje";
    if (n === 1) return "vence amanhã";
    return `vence em ${n} dias`;
  }
  let carregandoAlertas = false;
  async function loadAlertas() {
    if (!state.user || !temProprias() || carregandoAlertas) return;
    carregandoAlertas = true;
    const { data, error } = await sb.from("contas")
      .select("id, descricao, valor, vencimento, receber, origem, mes_referencia")
      .eq("user_id", state.user.id).eq("pago", false)
      .gte("vencimento", addDias(-60)).lte("vencimento", addDias(diasAviso()))
      .order("vencimento", { ascending: true }).limit(60);
    carregandoAlertas = false;
    if (error) return;
    state.alertas = data || [];
    mostrarAlertas();
  }
  function mostrarAlertas() {
    const n = state.alertas.length;
    const vencidas = state.alertas.filter((c) => diasAte(c.vencimento) < 0).length;
    const badge = $("#alertas-badge");
    badge.hidden = n === 0;
    badge.textContent = n > 9 ? "9+" : String(n);
    badge.classList.toggle("atrasado", vencidas > 0);
    try { if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); } catch {}
    // aviso no topo: aparece uma vez por dia
    const hoje = todayStr();
    const aviso = $("#vence-aviso");
    if (n && lsGet(`${LS.avisoVisto}.${state.user.id}`) !== hoje) {
      const pagar = state.alertas.filter((c) => !c.receber).length;
      const partes = [];
      if (vencidas) partes.push(`${vencidas} vencida${vencidas > 1 ? "s" : ""}`);
      if (n - vencidas) partes.push(`${n - vencidas} vencendo em até ${diasAviso()} dia${diasAviso() > 1 ? "s" : ""}`);
      aviso.textContent = `⏰ ${partes.join(" e ")}${pagar < n ? " (inclui contas a receber)" : ""}. Toque para ver.`;
      aviso.hidden = false;
    } else {
      aviso.hidden = true;
    }
    if (alertasDlg.open) renderAlertas();
  }
  function renderAlertas() {
    $("#alertas-dias").value = String(diasAviso());
    $("#alertas-lista").innerHTML = state.alertas.length ? `<ul class="alertas-ul">${state.alertas.map((c) => {
      const n = diasAte(c.vencimento);
      return `<li><button type="button" class="card alerta${n < 0 ? " atrasado" : n === 0 ? " hoje" : ""}" data-id="${c.id}">
        <span class="alerta-tit">${c.receber ? `<span class="badge visivel">a receber</span> ` : ""}${esc(c.descricao)}</span>
        <span class="alerta-val">${brl.format(Number(c.valor))}</span>
        <span class="alerta-quando">${quandoTxt(n)} · ${fmtDate(c.vencimento)}${c.origem ? " · " + esc(c.origem) : ""}</span>
      </button></li>`;
    }).join("")}</ul>` : `<p class="muted small">Nenhuma conta vencendo nos próximos ${diasAviso()} dias. 🎉</p>`;
  }
  async function abrirAlertas() {
    lsSet(`${LS.avisoVisto}.${state.user.id}`, todayStr());
    $("#vence-aviso").hidden = true;
    closeMenu();
    renderAlertas();
    renderPush();
    pegarChavePush().catch(() => {}); // já deixa a chave pronta para o toque em "Ativar"
    if (!alertasDlg.open) alertasDlg.showModal();
  }
  $("#alertas-btn").addEventListener("click", abrirAlertas);
  $("#vence-aviso").addEventListener("click", abrirAlertas);
  $("#alertas-close").addEventListener("click", () => alertasDlg.close());
  alertasDlg.addEventListener("click", (e) => { if (e.target === alertasDlg) alertasDlg.close(); });
  $("#alertas-dias").addEventListener("change", (e) => {
    lsSet(LS.avisoDias, e.target.value);
    loadAlertas();
    renderPush();
    sb.rpc("definir_aviso_dias", { p_dias: Number(e.target.value) }).then(() => {}, () => {});
  });
  $("#alertas-lista").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-id]");
    if (!b) return;
    const a = state.alertas.find((x) => x.id === b.dataset.id);
    if (!a) return;
    alertasDlg.close();
    state.month = a.mes_referencia.slice(0, 7);
    const v = a.receber ? "receber" : "minhas";
    if (state.visao !== v) { state.visao = v; lsSet(`${LS.visao}.${state.user.id}`, v); aplicarPapel(); }
    state.origem = ""; lsSet(LS.origem, "");
    await loadMonth();
    const conta = state.contas.find((c) => c.id === a.id);
    if (conta) openForm(conta);
  });

  // ---------------------------------------------------------------- notificações no celular
  // O aviso sai do servidor (todo dia às 8h). Aqui só guardamos o "endereço" de notificação deste aparelho.
  const ehIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const instalado = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const pushSuportado = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  let chavePush = null;
  let inscricaoAtual = null;

  async function chamarPush(body) {
    const { data, error } = await sb.functions.invoke("push", { body });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch {}
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }
  async function pegarChavePush() {
    if (chavePush || !state.user || !pushSuportado()) return chavePush;
    const r = await chamarPush({ acao: "chave" });
    chavePush = r.chave;
    return chavePush;
  }
  function chaveBytes(b64) {
    const s = b64.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(s + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  async function inscricaoDoAparelho() {
    if (!pushSuportado()) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? await reg.pushManager.getSubscription() : null;
  }
  function nomeAparelho() {
    const ua = navigator.userAgent;
    if (/iphone/i.test(ua)) return "iPhone";
    if (/ipad/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "iPad";
    if (/android/i.test(ua)) return "Android";
    if (/mac/i.test(ua)) return "Mac";
    if (/windows/i.test(ua)) return "Windows";
    return "Navegador";
  }
  async function salvarInscricao(sub) {
    const j = sub.toJSON();
    const { error } = await sb.rpc("salvar_inscricao", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_aparelho: nomeAparelho() });
    if (error) throw error;
    sb.rpc("definir_aviso_dias", { p_dias: diasAviso() }).then(() => {}, () => {});
  }

  async function renderPush() {
    const st = $("#push-status"), at = $("#push-ativar"), te = $("#push-teste"), de = $("#push-desativar");
    at.hidden = te.hidden = de.hidden = true;
    if (ehIOS && !instalado()) {
      st.textContent = "No iPhone, as notificações só funcionam com o app instalado: no Safari, toque em Compartilhar e em “Adicionar à Tela de Início”, depois abra o Contas pelo ícone.";
      return;
    }
    if (!pushSuportado()) {
      st.textContent = "Este aparelho não recebe notificações do app. No iPhone, é preciso o iOS 16.4 ou mais novo e o app instalado na Tela de Início.";
      return;
    }
    if (Notification.permission === "denied") {
      st.textContent = ehIOS
        ? "As notificações estão bloqueadas. Libere em Ajustes › Notificações › Contas e volte aqui."
        : "As notificações estão bloqueadas para este site. Libere nas configurações do navegador e volte aqui.";
      return;
    }
    inscricaoAtual = await inscricaoDoAparelho().catch(() => null);
    if (inscricaoAtual && Notification.permission === "granted") {
      st.textContent = `✅ Ativadas neste aparelho. Todo dia às 8h você recebe o aviso das contas que vencem em até ${diasAviso()} dia${diasAviso() > 1 ? "s" : ""}.`;
      te.hidden = de.hidden = false;
    } else {
      st.textContent = "Receba um aviso no celular, mesmo com o app fechado, quando uma conta estiver para vencer.";
      at.hidden = false;
    }
  }

  $("#push-ativar").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      // o pedido de permissão precisa ser a primeira coisa depois do toque (exigência do iPhone)
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { await renderPush(); if (perm === "default") toast("Você não respondeu ao pedido de notificações."); return; }
      const chave = await pegarChavePush();
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveBytes(chave) });
      await salvarInscricao(sub);
      const r = await chamarPush({ acao: "teste" });
      toast(r?.ok ? "Notificações ativadas. Chegou um teste no seu celular." : "Notificações ativadas.");
    } catch (ex) {
      toast("Não deu para ativar: " + friendlyError(ex));
    } finally {
      b.disabled = false;
      renderPush();
    }
  });
  $("#push-teste").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const sub = await inscricaoDoAparelho();
      if (sub) await salvarInscricao(sub);
      const r = await chamarPush({ acao: "teste" });
      toast(r?.ok ? "Teste enviado. Deve chegar em alguns segundos." : "O teste não foi entregue. Toque em Desativar e ative de novo.");
    } catch (ex) {
      toast(friendlyError(ex));
    } finally {
      b.disabled = false;
    }
  });
  $("#push-desativar").addEventListener("click", async () => {
    try {
      const sub = await inscricaoDoAparelho();
      if (sub) {
        await sb.rpc("remover_inscricao", { p_endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      toast("Notificações desativadas neste aparelho.");
    } catch (ex) {
      toast(friendlyError(ex));
    }
    renderPush();
  });

  // a cada login: se este aparelho já tinha notificações, liga a inscrição à pessoa que entrou
  async function sincronizarPush() {
    try {
      if (!pushSuportado() || Notification.permission !== "granted") return;
      const sub = await inscricaoDoAparelho();
      if (sub) await salvarInscricao(sub);
    } catch {}
  }

  // tocar numa notificação com o app já aberto
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.tipo !== "abrir") return;
      const url = new URL(e.data.url);
      if (url.searchParams.has("usuarios") && nucleo.ehAdmin()) nucleo.abrirUsuarios();
      else if (state.user) { loadMonth(); loadAlertas(); }
    });
  }

  // dica de instalar no iPhone (só aparece no Safari, fora do app instalado)
  (function dicaInstalar() {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const instalado = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
    if (!ios || instalado) return;
    document.querySelectorAll("[data-instalar]").forEach((el) => { el.hidden = false; });
    if (!lsGet(LS.instalarFechado)) $("#instalar-card").hidden = false;
    $("#instalar-fechar").addEventListener("click", () => { $("#instalar-card").hidden = true; lsSet(LS.instalarFechado, "1"); });
  })();


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
  nucleo.comecar();
})();
