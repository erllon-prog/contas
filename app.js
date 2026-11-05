(() => {
  "use strict";

  const CFG = window.CONTAS_CONFIG;
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  const MAX_FILE_MB = 10;
  const ORIGENS_PADRAO = ["Cartão de crédito", "Pix", "Boleto", "Débito automático", "Dinheiro", "Transferência"];

  // ---------------------------------------------------------------- estado
  const state = {
    user: null,
    month: currentMonthKey(),   // "AAAA-MM"
    contas: [],
    filter: "todas",
    origem: "",                 // filtro de origem ("" = todas)
    editing: null,              // conta em edição (ou null)
    removeNota: false
  };

  // ---------------------------------------------------------------- utilitários
  const $ = (sel) => document.querySelector(sel);
  const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

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
    sb.auth.onAuthStateChange((_event, session) => setUser(session?.user || null));
  }

  function setUser(user) {
    const changed = (user?.id || null) !== (state.user?.id || null);
    state.user = user;
    $("#view-login").hidden = !!user;
    $("#view-app").hidden = !user;
    if (user && changed) loadMonth();
    if (!user) { state.contas = []; render(); }
  }

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
    const { data, error } = await sb
      .from("contas")
      .select("*")
      .eq("mes_referencia", monthToDb(state.month))
      .order("vencimento", { ascending: true, nullsFirst: false })
      .order("descricao", { ascending: true });
    if (error) { toast(friendlyError(error)); return; }
    state.contas = data || [];
    render();
  }

  function isOverdue(c) {
    return !c.pago && c.vencimento && c.vencimento < todayStr();
  }

  function render() {
    const list = $("#list");
    const doMes = state.contas;
    const all = state.origem ? doMes.filter((c) => (c.origem || "") === state.origem) : doMes;

    const total = all.reduce((s, c) => s + Number(c.valor), 0);
    const pago = all.filter((c) => c.pago).reduce((s, c) => s + Number(c.valor), 0);
    $("#sum-total").textContent = brl.format(total);
    $("#sum-paid").textContent = brl.format(pago);
    $("#sum-open").textContent = brl.format(total - pago);
    $("#progress-bar").style.width = total > 0 ? `${Math.round((pago / total) * 100)}%` : "0%";

    let rows = all;
    if (state.filter === "abertas") rows = all.filter((c) => !c.pago);
    if (state.filter === "pagas") rows = all.filter((c) => c.pago);
    // não pagas primeiro, depois pagas
    rows = [...rows].sort((a, b) => Number(a.pago) - Number(b.pago));

    $("#empty").hidden = doMes.length > 0;
    if (all.length > 0 && rows.length === 0) {
      list.innerHTML = `<li class="empty">Nada por aqui neste filtro.</li>`;
    } else {
      list.innerHTML = rows.map(itemHtml).join("");
    }

    // sugestões de origem
    const origens = new Set(ORIGENS_PADRAO);
    doMes.forEach((c) => c.origem && origens.add(c.origem));
    $("#origens").innerHTML = [...origens].map((o) => `<option value="${esc(o)}">`).join("");

    // filtro de origem (só as que existem no mês, mais a selecionada)
    const usadas = [...new Set(doMes.map((c) => c.origem).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    if (state.origem && !usadas.includes(state.origem)) usadas.unshift(state.origem);
    const sel = $("#origem-filter");
    sel.innerHTML = `<option value="">Todas as origens</option>` +
      usadas.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
    sel.value = state.origem;
    sel.classList.toggle("active", !!state.origem);
  }

  const TIPO_LABEL = { avista: "À vista", parcelado: "Parcelado", mensal: "Mensal", avulso: "Avulso" };

  function itemHtml(c) {
    const meta = [];
    if (c.data_compra) meta.push(`<span>Compra ${fmtDate(c.data_compra)}</span>`);
    if (c.vencimento) {
      meta.push(isOverdue(c)
        ? `<span class="badge late">Venceu ${fmtDate(c.vencimento)}</span>`
        : `<span>Vence ${fmtDate(c.vencimento)}</span>`);
    }
    if (c.tipo === "parcelado" && c.parcela_atual && c.total_parcelas) {
      meta.push(`<span class="badge parcelado">${c.parcela_atual}/${c.total_parcelas}</span>`);
    } else {
      meta.push(`<span class="badge ${c.tipo}">${TIPO_LABEL[c.tipo] || c.tipo}</span>`);
    }
    if (c.origem) meta.push(`<span>${esc(c.origem)}</span>`);
    if (c.nota_path) meta.push(`<span title="Tem nota fiscal">📎</span>`);

    const cls = ["card", "item", c.pago ? "paid" : "", isOverdue(c) ? "overdue" : ""].join(" ");
    return `
      <li class="${cls}" data-id="${c.id}">
        <button class="pay-toggle" data-action="toggle" aria-label="${c.pago ? "Marcar como não paga" : "Marcar como paga"}"><span>✓</span></button>
        <button class="item-main" data-action="edit">
          <div class="item-title">${esc(c.descricao)}</div>
          <div class="item-meta">${meta.join("")}</div>
        </button>
        <div class="item-value">${brl.format(Number(c.valor))}</div>
      </li>`;
  }

  $("#list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.closest("li").dataset.id;
    const conta = state.contas.find((c) => c.id === id);
    if (!conta) return;
    if (btn.dataset.action === "edit") openForm(conta);
    if (btn.dataset.action === "toggle") togglePago(conta);
  });

  async function togglePago(conta) {
    const pago = !conta.pago;
    const patch = { pago, data_pagamento: pago ? (conta.data_pagamento || todayStr()) : null };
    Object.assign(conta, patch);       // atualiza na hora
    render();
    const { error } = await sb.from("contas").update(patch).eq("id", conta.id);
    if (error) { toast(friendlyError(error)); loadMonth(); }
  }

  // ---------------------------------------------------------------- navegação de mês
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

  $("#origem-filter").addEventListener("change", (e) => { state.origem = e.target.value; render(); });

  document.querySelectorAll(".chip").forEach((chip) => chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
    state.filter = chip.dataset.filter;
    render();
  }));

  // ---------------------------------------------------------------- menu
  function closeMenu() { $("#menu").hidden = true; }
  $("#menu-btn").addEventListener("click", (e) => { e.stopPropagation(); $("#menu").hidden = !$("#menu").hidden; });
  document.addEventListener("click", (e) => { if (!e.target.closest("#menu")) closeMenu(); });

  $("#copy-monthly").addEventListener("click", async () => {
    closeMenu();
    const prev = shiftMonthKey(state.month, -1);
    const { data, error } = await sb.from("contas").select("*")
      .eq("mes_referencia", monthToDb(prev)).eq("tipo", "mensal");
    if (error) { toast(friendlyError(error)); return; }
    const existentes = new Set(state.contas.map((c) => c.descricao.trim().toLowerCase()));
    const novas = (data || [])
      .filter((c) => !existentes.has(c.descricao.trim().toLowerCase()))
      .map((c) => ({
        descricao: c.descricao, valor: c.valor, tipo: "mensal", origem: c.origem, observacao: c.observacao,
        mes_referencia: monthToDb(state.month),
        vencimento: addMonthsDate(c.vencimento, 1),
        data_compra: null,
        pago: false
      }));
    if (!novas.length) { toast("Nenhuma conta mensal nova para trazer."); return; }
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
    const lines = [cols.join(";")].concat(state.contas.map((c) => cols.map((k) => cell(k === "valor" ? Number(c[k]) : c[k])).join(";")));
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

  function syncTipoFields() {
    const parcelado = form.tipo.value === "parcelado";
    $("#parcelas-row").hidden = !parcelado;
    $("#gerar-row").hidden = !parcelado || !!state.editing;
  }
  form.tipo.addEventListener("change", syncTipoFields);
  form.pago.addEventListener("change", () => {
    if (form.pago.checked && !form.data_pagamento.value) form.data_pagamento.value = todayStr();
    if (!form.pago.checked) form.data_pagamento.value = "";
  });

  function openForm(conta = null) {
    state.editing = conta;
    state.removeNota = false;
    form.reset();
    $("#form-error").hidden = true;
    $("#form-title").textContent = conta ? "Editar conta" : "Nova conta";
    $("#form-delete").hidden = !conta;

    if (conta) {
      form.descricao.value = conta.descricao;
      form.valor.value = valorToInput(conta.valor);
      form.vencimento.value = conta.vencimento || "";
      form.data_compra.value = conta.data_compra || "";
      form.tipo.value = conta.tipo;
      form.mes_referencia.value = conta.mes_referencia.slice(0, 7);
      form.parcela_atual.value = conta.parcela_atual || "";
      form.total_parcelas.value = conta.total_parcelas || "";
      form.origem.value = conta.origem || "";
      form.pago.checked = conta.pago;
      form.data_pagamento.value = conta.data_pagamento || "";
      form.observacao.value = conta.observacao || "";
    } else {
      form.tipo.value = "avista";
      form.mes_referencia.value = state.month;
      form.parcela_atual.value = 1;
    }
    $("#nota-atual").hidden = !(conta && conta.nota_path);
    syncTipoFields();
    dlg.showModal();
    if (!conta) setTimeout(() => form.descricao.focus(), 50);
  }

  $("#add-btn").addEventListener("click", () => openForm(null));
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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#form-error").hidden = true;

    const valor = parseValor(form.valor.value);
    if (!Number.isFinite(valor) || valor <= 0) return formError("Informe um valor válido, por exemplo 150,90.");

    const tipo = form.tipo.value;
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
      pago: form.pago.checked,
      data_pagamento: form.pago.checked ? (form.data_pagamento.value || todayStr()) : null,
      observacao: form.observacao.value.trim() || null
    };
    if (tipo === "parcelado") {
      if (!base.parcela_atual || !base.total_parcelas) return formError("Informe a parcela atual e o total de parcelas.");
      if (base.parcela_atual > base.total_parcelas) return formError("A parcela atual não pode ser maior que o total.");
    }

    const file = form.nota.files[0] || null;
    if (file && file.size > MAX_FILE_MB * 1024 * 1024) return formError(`O arquivo passa de ${MAX_FILE_MB} MB.`);

    const saveBtn = $("#form-save");
    saveBtn.disabled = true;
    saveBtn.textContent = "Salvando...";
    try {
      let conta;
      if (state.editing) {
        const { data, error } = await sb.from("contas").update(base).eq("id", state.editing.id).select().single();
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
        if (rows.length > 1) toast(`${rows.length} parcelas lançadas.`);
      }

      // nota fiscal
      const oldPath = state.editing?.nota_path || null;
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

      dlg.close();
      // se lançou em outro mês, vai para ele
      const mes = base.mes_referencia.slice(0, 7);
      if (mes !== state.month) state.month = mes;
      await loadMonth();
      if (!toastTimer || $("#toast").hidden) toast("Salvo.");
    } catch (err) {
      formError(friendlyError(err));
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Salvar";
    }
  });

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

  // ---------------------------------------------------------------- PDF para enviar
  const pdfDlg = $("#pdf-dialog");
  const pdfForm = $("#pdf-form");
  const PDF_ORIGEM_KEY = "contas.pdfOrigem";

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
    let saved = "";
    try { saved = localStorage.getItem(PDF_ORIGEM_KEY) || ""; } catch {}
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
      { label: "Parcela", x: 172, align: "right", get: (c) => (c.parcela_atual && c.total_parcelas ? `${c.parcela_atual}/${c.total_parcelas}` : "") },
      status
    ]);
    section("Mensais", mensais, [desc, valor, status]);
    section("Compras", avulsas, [
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
      try { localStorage.setItem(PDF_ORIGEM_KEY, origem); } catch {}
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
