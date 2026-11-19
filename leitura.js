// Contas v13 — transforma o que a IA leu da nota em sugestões para o formulário.
// Não acessa rede nem banco: recebe a leitura e o histórico da pessoa e devolve os campos.
// Ordem de confiança da descrição: 1) o que você usou da última vez nesse mesmo lugar (CNPJ ou nome);
// 2) uma descrição sua que combina com o tipo de compra (posto -> a sua "Combustível");
// 3) a descrição que a IA sugeriu (ou o nome padrão da categoria).
(function (root) {
  "use strict";

  const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const num = (v) => { const n = typeof v === "string" ? Number(v.replace(",", ".")) : Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : null; };
  const r2 = (n) => Math.round(n * 100) / 100;
  const cap = (s) => { s = String(s || "").trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; };

  // categoria -> nome padrão (null = usa a descrição da IA) e palavras que ligam às descrições que você já usa
  const CATS = {
    combustivel: { nome: "Combustível", chaves: ["combust", "gasolina", "etanol", "alcool", "diesel", "abastec", "posto"] },
    mercado:     { nome: "Mercado", chaves: ["mercado", "supermerc", "atacad", "hortifruti", "sacolao", "feira"] },
    farmacia:    { nome: "Farmácia", chaves: ["farmac", "remedio", "drogar", "medicament"] },
    restaurante: { nome: "Restaurante", chaves: ["restaur", "almoco", "jantar", "janta", "refeicao", "alimentac", "comida"] },
    lanche:      { nome: "Lanche", chaves: ["lanche", "ifood", "pizza", "hamburg", "acai", "sorvete"] },
    padaria:     { nome: "Padaria", chaves: ["padaria", "pao", "panific"] },
    saude:       { nome: "Saúde", chaves: ["saude", "consulta", "exame", "dentista", "medico", "clinica", "laborat"] },
    roupas:      { nome: "Roupas", chaves: ["roupa", "calcad", "tenis", "sapato", "vestuar"] },
    casa:        { nome: "Casa", chaves: ["casa", "utilidade", "limpeza", "movei", "decorac"] },
    construcao:  { nome: "Material de construção", chaves: ["constru", "ferrag", "tinta"] },
    eletronicos: { nome: null, chaves: ["eletron", "celular", "fone", "informat", "computador"] },
    automotivo:  { nome: null, chaves: ["carro", "pneu", "oficina", "mecanic", "oleo", "lavagem", "lava jato", "moto"] },
    pet:         { nome: "Pet", chaves: ["pet", "racao", "veterin"] },
    educacao:    { nome: "Educação", chaves: ["curso", "escola", "faculdade", "livro", "educac"] },
    lazer:       { nome: "Lazer", chaves: ["lazer", "cinema", "show", "ingresso", "bar", "festa"] },
    viagem:      { nome: "Viagem", chaves: ["viagem", "hotel", "pousada", "passagem", "hosped"] },
    transporte:  { nome: null, chaves: ["uber", "onibus", "transporte", "estacionament", "pedagio", "taxi"] },
    servicos:    { nome: null, chaves: [] },
    contas_casa: { nome: null, chaves: ["luz", "energia", "agua", "internet", "telefone", "gas"] },
    academia:    { nome: "Academia", chaves: ["academia", "gym", "crossfit"] },
    beleza:      { nome: null, chaves: ["cabelo", "barbe", "salao", "beleza", "manicure", "cosmet"] },
    presente:    { nome: "Presente", chaves: ["presente"] },
    impostos:    { nome: null, chaves: ["imposto", "irpf", "ipva", "iptu", "multa", "licenciament"] },
    outros:      { nome: null, chaves: [] }
  };

  // palavra curta (pao, bar, gas, pet, luz) só vale inteira; as longas valem como começo de palavra
  function combina(texto, chave) {
    const t = " " + norm(texto) + " ";
    if (chave.includes(" ")) return t.includes(" " + chave);
    const re = chave.length <= 4 ? new RegExp(`[^a-z0-9]${chave}[^a-z0-9]`) : new RegExp(`[^a-z0-9]${chave}`);
    return re.test(t);
  }

  // nomes de banco/carteira como aparecem na maquininha -> nome comum (para achar a sua origem)
  const BANCOS = [
    ["nubank", /\bnu\b|nubank|nu pagamentos|nu financeira/],
    ["picpay", /picpay|pic pay/],
    ["mercado pago", /mercado ?pago|mercadopago/],
    ["itau", /itau|itaucard/],
    ["inter", /\binter\b|banco inter/],
    ["c6", /\bc6\b|c6 bank/],
    ["bradesco", /bradesco/],
    ["santander", /santander/],
    ["caixa", /\bcaixa\b|\bcef\b/],
    ["banco do brasil", /banco do brasil|\bbb\b|ourocard/],
    ["sicredi", /sicredi/],
    ["sicoob", /sicoob/],
    ["neon", /\bneon\b/],
    ["will", /\bwill\b|will bank/],
    ["pagbank", /pagbank|pagseguro/]
  ];
  const banco = (t) => { const n = norm(t); const b = BANCOS.find(([, re]) => re.test(n)); return b ? b[0] : n; };

  function dataValida(s, hoje) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split("-").map(Number);
    if (y < 2000 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    if (hoje && s > (Number(hoje.slice(0, 4)) + 1) + hoje.slice(4)) return null; // mais de 1 ano no futuro: leitura errada
    return s;
  }

  /**
   * @param r   resposta da leitura (ler-foto, tipo "conta")
   * @param ctx { historico: [{descricao, origem, tipo, total_parcelas, leitura}] do mais novo para o mais velho,
   *              descricoes: [{descricao, qtd}] da mais usada para a menos usada,
   *              origens: [string] da mais usada para a menos usada,
   *              hoje: "AAAA-MM-DD" }
   */
  function sugerir(r, ctx) {
    r = r || {}; ctx = ctx || {};
    const hist = ctx.historico || [], descs = (ctx.descricoes || []).slice().sort((a, b) => (b.qtd || 0) - (a.qtd || 0)), origens = (ctx.origens || []).filter((o) => o && !o.startsWith("@"));
    const out = { fontes: {} };

    // ---------- mesmo lugar de antes (CNPJ ou nome) ----------
    const cnpj = String(r.cnpj || "").replace(/\D/g, "");
    const estab = norm(r.estabelecimento);
    const lugar = hist.find((h) => h.leitura && ((cnpj.length === 14 && h.leitura.cnpj === cnpj) || (estab && norm(h.leitura.estabelecimento) === estab)));

    // ---------- categoria ----------
    const litros = num(r.litros);
    let cat = CATS[r.categoria] ? r.categoria : null;
    if (litros || ["gasolina", "etanol", "diesel", "gnv"].includes(r.combustivel)) cat = "combustivel";

    // ---------- descrição ----------
    const daIA = String(r.descricao || "").trim();
    if (lugar) { out.descricao = lugar.descricao; out.fontes.descricao = "lugar"; }
    if (!out.descricao && daIA) {
      const igual = descs.find((d) => norm(d.descricao) === norm(daIA));
      if (igual) { out.descricao = igual.descricao; out.fontes.descricao = "sua"; }
    }
    if (!out.descricao && cat && CATS[cat].chaves.length) {
      const sua = descs.find((d) => CATS[cat].chaves.some((k) => combina(d.descricao, k)));
      if (sua) { out.descricao = sua.descricao; out.fontes.descricao = "sua"; }
    }
    if (!out.descricao && cat === "combustivel") { out.descricao = "Combustível"; out.fontes.descricao = "regra"; }
    if (!out.descricao && daIA) {
      const nd = norm(daIA);
      const parecida = nd.length >= 4 && descs.find((d) => { const n = norm(d.descricao); return n.length >= 4 && (n.startsWith(nd) || nd.startsWith(n)); });
      out.descricao = parecida ? parecida.descricao : cap(daIA);
      out.fontes.descricao = parecida ? "sua" : "ia";
    }
    if (!out.descricao && cat && CATS[cat].nome) { out.descricao = CATS[cat].nome; out.fontes.descricao = "regra"; }
    if (!out.descricao && r.estabelecimento) { out.descricao = cap(r.estabelecimento); out.fontes.descricao = "ia"; }
    if (out.descricao) out.descricao = out.descricao.slice(0, 120);

    // ---------- origem (cartão, banco ou forma de pagamento) ----------
    const final = String(r.cartaoFinal || "").replace(/\D/g, "");
    if (final.length === 4) {
      const h = hist.find((x) => x.origem && x.leitura && x.leitura.cartaoFinal === final);
      if (h) { out.origem = h.origem; out.fontes.origem = "cartao"; }
    }
    if (!out.origem && r.emissor) {
      const e = banco(r.emissor);
      const o = e.length >= 2 && origens.find((x) => { const n = banco(x); return n === e || (n.length >= 3 && e.length >= 3 && (n.includes(e) || e.includes(n))); });
      if (o) { out.origem = o; out.fontes.origem = "banco"; }
    }
    if (!out.origem && ["pix", "debito", "dinheiro"].includes(r.pagamento)) {
      const o = origens.find((x) => combina(x, r.pagamento));
      if (o) { out.origem = o; out.fontes.origem = "pagamento"; }
    }
    if (!out.origem && lugar && lugar.origem && !lugar.origem.startsWith("@") && final.length !== 4 && !r.emissor) {
      out.origem = lugar.origem; out.fontes.origem = "lugar";
    }

    // ---------- valor, tipo e parcelas ----------
    const total = num(r.valorTotal);
    const n = Math.round(Number(r.parcelas) || 1);
    if (n > 1 && n <= 72) {
      out.tipo = "parcelado"; out.parcelaAtual = 1; out.totalParcelas = n;
      out.valor = num(r.valorParcela) ? r2(num(r.valorParcela)) : (total ? r2(total / n) : null);
    } else {
      out.valor = total ? r2(total) : null;
      // conta que você lança todo mês (luz, internet...) continua mensal
      if (lugar && lugar.tipo === "mensal") out.tipo = "mensal";
      else if (lugar && lugar.tipo === "avulso") out.tipo = "avulso";
    }

    // ---------- datas ----------
    out.data = dataValida(r.data, ctx.hoje);
    out.vencimento = dataValida(r.vencimento, ctx.hoje);

    // ---------- observação: para lembrar o que foi ----------
    const partes = [];
    if (r.estabelecimento) partes.push(String(r.estabelecimento).trim());
    if (litros) partes.push(`${String(litros).replace(".", ",")} L${r.combustivel ? " de " + r.combustivel : ""}`);
    else if (Array.isArray(r.itens)) partes.push(...r.itens.filter((i) => typeof i === "string" && i.trim()).slice(0, 3).map((i) => i.trim()));
    out.observacao = partes.join(" · ").slice(0, 500);

    // ---------- o que fica guardado com a conta (para aprender da próxima vez) ----------
    const leitura = {
      estabelecimento: r.estabelecimento ? String(r.estabelecimento).trim().slice(0, 80) : null,
      cnpj: cnpj.length === 14 ? cnpj : null,
      cartaoFinal: final.length === 4 ? final : null,
      emissor: r.emissor ? String(r.emissor).slice(0, 40) : null,
      pagamento: r.pagamento || null,
      documento: r.documento || null,
      categoria: cat,
      litros,
      combustivel: r.combustivel || null,
      itens: Array.isArray(r.itens) ? r.itens.filter((i) => typeof i === "string").slice(0, 4).map((i) => i.slice(0, 60)) : null
    };
    Object.keys(leitura).forEach((k) => { if (leitura[k] === null || (Array.isArray(leitura[k]) && !leitura[k].length)) delete leitura[k]; });
    out.leitura = leitura;
    out.lugar = lugar ? (r.estabelecimento || lugar.leitura.estabelecimento || "") : null;
    return out;
  }

  root.ContasLeitura = { sugerir, norm, CATS };
})(typeof window !== "undefined" ? window : globalThis);
