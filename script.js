// Fonte oficial do painel. A API deve autorizar o domínio desta aplicação via CORS.
const ERP_DOCUMENTOS_API_URL = 'https://gestao.maisintegradora.com.br/api/documentos';
const ERP_DOCUMENTOS_TIMEOUT_MS = 15000;

function textoNormalizado(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleUpperCase('pt-BR');
}

function normalizarUrlExterna(valor) {
  const url = String(valor || '').trim();
  if (!url) return '';

  try {
    const urlParseada = new URL(url);
    return ['http:', 'https:'].includes(urlParseada.protocol) ? urlParseada.href : '';
  } catch (_) {
    return '';
  }
}

// A view do ERP ainda não expõe categoria. As regras preservam a classificação
// histórica e deixam o critério centralizado até que a categoria venha da API.
function classificarCategoriaDocumentoERP(registro) {
  const texto = textoNormalizado([
    registro.descricaodoc,
    registro.descricao_doc,
    registro.documento,
    registro.tipodoc
  ].filter(Boolean).join(' '));

  if (/(REGISTRO DE EMPREGADO|CONFIDENCIALIDADE|TERMO DE RESP|COMODATO)/.test(texto)) return 'RH/ADM';
  if (/(FUNDO DE DESENVOLVIMENTO INDUSTRIAL|CONTABIL)/.test(texto)) return 'jurídico/contábil';
  if (/(CONFORMIDADE|LICENCIAMENTO|PROCURACAO)/.test(texto)) return 'jurídico/corporativo';
  if (/(CNPJ|DEBITOS TRABALHISTAS|CERTIFICADO DIGITAL FISCAL)/.test(texto)) return 'fiscal&trabalhista';
  if (/DEB(?:ITOS)? ESTADUAIS/.test(texto)) return 'Licitacao';
  if (/(SEGURO|RASTREAMENTO|MARCAS E PATENTES|VIVO EMPRESA|CARTOES FLASH|ALUGUEL|ARMAZENAMENTO NUVEM|GESTAO FINANCEIRA|SEGURANCA DO TRAB|COMERCIAL DE LOCACAO)/.test(texto)) return 'corporativo';
  return 'jurídico';
}

function adaptarDocumentoERP(registro) {
  if (!registro || typeof registro !== 'object' || registro.sequencial == null) return null;

  const descricao = String(registro.descricaodoc || registro.descricao_doc || '').trim();
  return {
    id: String(registro.sequencial),
    documento: String(registro.documento || '').trim(),
    tipo_doc: String(registro.tipodoc || '').trim(),
    tipos: String(registro.descricao_doc || '').trim(),
    emissao: registro.dataemissao || null,
    vencimento: registro.datafinalvalidade || null,
    descricao_observacao: descricao,
    orgao_expeditor: String(registro.nome_orgao || registro.orgaoexpedidor || '').trim(),
    site_email: normalizarUrlExterna(registro.siteemail),
    arquivo: String(registro.caminhoarquivo || '').trim(),
    data_renovacao: registro.datarenovacao || null,
    cad_data: registro.caddata || null,
    categoria: classificarCategoriaDocumentoERP(registro),
    status_erp: String(registro.status || '').trim().toUpperCase()
  };
}

async function buscarDocumentosERP() {
  const controlador = new AbortController();
  const timeout = window.setTimeout(() => controlador.abort(), ERP_DOCUMENTOS_TIMEOUT_MS);

  try {
    const resposta = await fetch(ERP_DOCUMENTOS_API_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      signal: controlador.signal
    });

    if (!resposta.ok) {
      throw new Error(`A API de documentos retornou o status ${resposta.status}.`);
    }

    const dados = await resposta.json();
    if (!Array.isArray(dados)) {
      throw new Error('A API de documentos retornou um formato inválido.');
    }

    return dados
      .filter((registro) => String(registro && registro.status || '').trim().toUpperCase() !== 'C')
      .map(adaptarDocumentoERP)
      .filter(Boolean);
  } catch (erro) {
    if (erro && erro.name === 'AbortError') {
      throw new Error('A API de documentos demorou mais que o tempo limite para responder.');
    }
    if (erro && erro.name === 'TypeError') {
      throw new Error('Não foi possível conectar à API de documentos. Verifique a conexão e a autorização CORS deste domínio.');
    }
    throw erro;
  } finally {
    window.clearTimeout(timeout);
  }
}

// Inicialização do Alpine.js
document.addEventListener('alpine:init', () => {
  Alpine.data('dashboard', () => ({
    documentos: [],
    notificacoes: [],
    loading: false,
    notificationsLoading: false,
    errorMessage: '',
    notificationsErrorMessage: '',
    search: '',
    statusFilter: '',
    categoriaFilter: '',
    selected: null,
    showExportModal: false,
    showNotificationsPanel: false,
    notificationsCount: 0,
    notificationsReadIds: [],

    async init() {
      this.$watch('selected', () => this.atualizarBloqueioScroll());
      this.$watch('showExportModal', () => this.atualizarBloqueioScroll());
      this.$watch('showNotificationsPanel', () => this.atualizarBloqueioScroll());

      this.carregarIdsNotificacoesLidas();
      await this.carregar();
    },

    atualizarBloqueioScroll() {
      this.toggleScrollLock(!!(this.selected || this.showExportModal || this.showNotificationsPanel));
    },

    toggleScrollLock(isLocked) {
      if (isLocked) document.body.classList.add('overflow-hidden');
      else document.body.classList.remove('overflow-hidden');
    },

    notificationsSinceIso() {
      const base = this.todayDate();
      base.setMonth(base.getMonth() - 3);
      base.setHours(0, 0, 0, 0);
      return base.toISOString();
    },

    notificationsReadStorageKey() {
      return 'documentacoes_notifications_read_ids_v1';
    },

    carregarIdsNotificacoesLidas() {
      try {
        const raw = window.localStorage.getItem(this.notificationsReadStorageKey());
        const parsed = raw ? JSON.parse(raw) : [];
        this.notificationsReadIds = Array.isArray(parsed) ? parsed.map((id) => String(id)) : [];
      } catch (e) {
        this.notificationsReadIds = [];
      }
    },

    salvarIdsNotificacoesLidas() {
      try {
        window.localStorage.setItem(
          this.notificationsReadStorageKey(),
          JSON.stringify(this.notificationsReadIds)
        );
      } catch (e) {
        console.warn('Falha ao guardar notificações lidas localmente:', e.message);
      }
    },

    notificacaoJaLida(item) {
      if (!item || item.id == null) return false;
      return this.notificationsReadIds.includes(String(item.id));
    },

    marcarNotificacaoComoLida(item) {
      if (!item || item.id == null) return;

      const id = String(item.id);
      if (!this.notificationsReadIds.includes(id)) {
        this.notificationsReadIds = [...this.notificationsReadIds, id];
        this.salvarIdsNotificacoesLidas();
      }

      this.atualizarContadorNotificacoes();
    },

    atualizarContadorNotificacoes() {
      const unreadCount = this.notificacoes.filter((item) => !this.notificacaoJaLida(item)).length;
      this.notificationsCount = unreadCount;
    },

    notificationItemClass(item) {
      if (this.notificacaoJaLida(item)) {
        return 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-md focus:ring-slate-200';
      }

      return 'border-blue-200 bg-blue-50/80 hover:border-blue-300 hover:shadow-md focus:ring-blue-200';
    },

    notificationIconWrapClass(item) {
      if (this.notificacaoJaLida(item)) {
        return 'bg-slate-100 text-slate-500';
      }

      return 'bg-blue-100 text-blue-700';
    },

    notificationIconClass(item) {
      return this.notificacaoJaLida(item) ? 'text-slate-500' : 'text-blue-700';
    },

    notificationTitleClass(item) {
      return this.notificacaoJaLida(item) ? 'text-slate-800' : 'text-slate-900';
    },

    notificationTextClass(item) {
      return this.notificacaoJaLida(item) ? 'text-slate-600' : 'text-slate-700';
    },

    notificationDateClass(item) {
      return this.notificacaoJaLida(item) ? 'text-slate-400' : 'text-blue-600 font-medium';
    },

    async carregarNotificacoes() {
      this.notificationsLoading = true;
      this.notificationsErrorMessage = '';

      try {
        this.notificacoes = this.gerarNotificacoesVencimento();

        const notificationIds = new Set(this.notificacoes.map((item) => String(item.id)));
        this.notificationsReadIds = this.notificationsReadIds.filter((id) => notificationIds.has(id));
        this.salvarIdsNotificacoesLidas();
        this.atualizarContadorNotificacoes();
      } catch (e) {
        console.error('Falha ao carregar notificações:', e.message);
        this.notificationsErrorMessage = e.message;
      } finally {
        this.notificationsLoading = false;
      }
    },

    gerarNotificacoesVencimento() {
      const hoje = this.todayDate();

      return this.documentos
        .map((doc) => {
          const tipoDocumento = String(doc.tipo_doc || doc.tipoDocumento || '').trim().toUpperCase();
          if (tipoDocumento === 'CON' && !doc.vencimento) return null;

          const vencimento = this.parseDate(doc.vencimento);
          if (!vencimento || vencimento.getFullYear() === 2999) return null;

          const dias = this.diffInDays(hoje, vencimento);
          if (dias == null || dias > 7) return null;

          const tipoEvento = dias < 0 ? 'vencido' : 'vence_em_breve';
          return {
            id: `vencimento-${doc.id}-${tipoEvento}`,
            documento_id: doc.id,
            apelido: doc.apelido || doc.documento || 'Documento sem identificacao',
            documento: doc.documento,
            categoria: doc.categoria,
            tipo_evento: tipoEvento,
            status_anterior: null,
            status_novo: tipoEvento,
            dias_restantes: dias,
            vencimento: doc.vencimento,
            data_evento: doc.vencimento
          };
        })
        .filter(Boolean)
        .sort((a, b) => {
          const prioridadeA = a.tipo_evento === 'vencido' ? 0 : 1;
          const prioridadeB = b.tipo_evento === 'vencido' ? 0 : 1;
          return prioridadeA - prioridadeB || a.dias_restantes - b.dias_restantes;
        });
    },

    async toggleNotificationsPanel() {
      if (this.showNotificationsPanel) {
        this.showNotificationsPanel = false;
        return;
      }

      this.showNotificationsPanel = true;
      await this.carregarNotificacoes();
    },

    closeNotificationsPanel() {
      this.showNotificationsPanel = false;
    },

    parseDate(dateValue) {
      if (!dateValue) return null;

      const raw = String(dateValue).trim();
      if (!raw) return null;
      if (raw.includes('2999')) return new Date(2999, 0, 1);

      const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (isoMatch) {
        return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
      }

      const brMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (brMatch) {
        return new Date(Number(brMatch[3]), Number(brMatch[2]) - 1, Number(brMatch[1]));
      }

      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) return null;

      return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
    },

    parseDateTime(dateValue) {
      if (!dateValue) return null;

      const parsed = new Date(dateValue);
      if (Number.isNaN(parsed.getTime())) return null;

      return parsed;
    },

    formatNotificationDate(dateValue) {
      const parsed = this.parseDateTime(dateValue);
      if (!parsed) return '-';

      return parsed.toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    },

    todayDate() {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    },

    diffInDays(fromDate, toDate) {
      if (!(fromDate instanceof Date) || Number.isNaN(fromDate.getTime())) return null;
      if (!(toDate instanceof Date) || Number.isNaN(toDate.getTime())) return null;

      const oneDay = 24 * 60 * 60 * 1000;
      return Math.round((toDate.getTime() - fromDate.getTime()) / oneDay);
    },

    getDiasRestantes(doc) {
      if (!doc) return null;

      const valor = doc.dias_restantes != null ? doc.dias_restantes : doc.diasRestantes;
      if (valor != null && valor !== '') {
        const numero = Number(valor);
        if (!Number.isNaN(numero)) return numero;
      }

      const vencimento = this.parseDate(doc.vencimento);
      if (!vencimento || vencimento.getFullYear() === 2999) return null;

      return this.diffInDays(this.todayDate(), vencimento);
    },

    getStatusPrazo(doc) {
      if (!doc) return '';

      return doc.status_prazo || doc.statusPrazo || '';
    },

    statusResumo(doc) {
      if (doc && String(doc.tipo_doc || '').trim().toUpperCase() === 'CON' && !doc.vencimento) {
        return 'em_dia';
      }

      return this.getStatusPrazo(doc);
    },

    calcularStatusFallback(doc) {
      if (!doc) return 'em_dia';

      const tipoDocumento = String(doc.tipo_doc || doc.tipoDocumento || '').trim().toUpperCase();
      const vencimento = this.parseDate(doc.vencimento);
      const dataSugerida = this.parseDate(doc.data_sugerida_renovacao || doc.dataSugeridaRenovacao);
      const hoje = this.todayDate();

      if (!vencimento && tipoDocumento === 'CON') return 'em_dia';
      if (vencimento && vencimento.getFullYear() === 2999) return 'em_dia';
      if (vencimento) {
        const diasAteVencimento = this.diffInDays(hoje, vencimento);
        if (diasAteVencimento < 0) return 'vencido';
        if (diasAteVencimento <= 90) return 'vence_em_breve';
        return 'em_dia';
      }
      if (dataSugerida && hoje >= dataSugerida) return 'vence_em_breve';

      const dias = this.getDiasRestantes(doc);
      if (dias != null) {
        if (dias < 0) return 'vencido';
        if (dias <= 90) return 'vence_em_breve';
      }

      return 'em_dia';
    },

    normalizarDocumento(doc) {
      const documento = { ...doc };
      documento.descricao = documento.descricao || documento.descricao_observacao;
      documento.site = documento.site || documento.site_email;
      documento.caminho_arquivo = documento.caminho_arquivo || documento.caminhoArquivo || documento.arquivo;
      const vencimentoTexto = documento.vencimento != null ? String(documento.vencimento) : '';
      const statusAtual = this.getStatusPrazo(documento);
      const dias = this.getDiasRestantes(documento);

      documento.is_vitalicio = vencimentoTexto.includes('2999');

      if (documento.is_vitalicio || (String(documento.tipo_doc || '').trim().toUpperCase() === 'CON' && !documento.vencimento)) {
        documento.status_prazo = 'em_dia';
      } else if (documento.vencimento) {
        documento.status_prazo = this.calcularStatusFallback(documento);
      } else if (statusAtual) {
        documento.status_prazo = statusAtual;
      } else {
        documento.status_prazo = this.calcularStatusFallback(documento);
      }

      if (dias != null) {
        documento.dias_restantes = dias;
      }

      return documento;
    },

    async carregar() {
      this.loading = true;
      this.errorMessage = '';

      try {
        this.documentos = (await buscarDocumentosERP())
          .map((doc) => this.normalizarDocumento(doc));
        await this.carregarNotificacoes();
      } catch (e) {
        console.error('Falha na comunicação com a API de documentos:', e);
        this.errorMessage = e && e.message
          ? e.message
          : 'Não foi possível carregar os documentos do ERP.';
      } finally {
        this.loading = false;
      }
    },

    limparFiltros() {
      this.search = '';
      this.statusFilter = '';
      this.categoriaFilter = '';
    },

    nomeDocumento(doc) {
      if (!doc) return '-';
      return doc.apelido || doc.documento || doc.nome || doc.nome_documento || '-';
    },

    // --- MOTOR DE EXPORTAÇÃO CSV ---
    descricaoInternaCompleta(doc) {
      if (!doc) return '';
      return String(doc.descricao || doc.descricao_observacao || '').trim();
    },

    descricaoInternaCurta(doc) {
      const descricaoExibidaCompleta = this.descricaoInternaCompleta(doc)
        .replace(/^MHS\b\s*/i, '')
        .replace(/\s+-\s+/g, ' ')
        .trim();
      const prepararPalavras = (item) => this.descricaoInternaCompleta(item)
        .replace(/^MHS\b\s*/i, '')
        .replace(/\s+-\s+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);

      const normalizarResumo = (texto) => texto.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
      const normalizarPalavra = (texto) => normalizarResumo(texto).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const palavrasDoc = prepararPalavras(doc);
      const palavrasNormalizadas = palavrasDoc.map(normalizarPalavra);
      const casoCertidaoNegativa = palavrasNormalizadas.some((palavra, indice) =>
        palavra === 'certidao' && palavrasNormalizadas[indice + 1] === 'negativa'
      );
      const casoTcuCertidaoNada = palavrasNormalizadas[0] === 'tcu' &&
        palavrasNormalizadas[1] === 'certidao' && palavrasNormalizadas[2] === 'nada';
      const casoExibirCompleto = casoCertidaoNegativa || casoTcuCertidaoNada;
      if (casoExibirCompleto) return descricaoExibidaCompleta || '-';

      const palavrasDeLigacao = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'para']);
      const palavrasGenericasCertidao = new Set(['certidão', 'negativa']);
      const entradas = this.documentosVisiveisNaListagem.map((item) => {
        const palavras = prepararPalavras(item);
        let quantidade = Math.min(2, palavras.length);

        // "Certidão" e "certidão negativa" precisam do assunto para identificar o documento.
        const indiceCertidao = palavras.findIndex((palavra) => normalizarResumo(palavra) === 'certidão');
        if (indiceCertidao >= 0) {
          let indiceAssunto = indiceCertidao + 1;
          while (indiceAssunto < palavras.length &&
            (palavrasDeLigacao.has(normalizarResumo(palavras[indiceAssunto])) ||
             palavrasGenericasCertidao.has(normalizarResumo(palavras[indiceAssunto])))) {
            indiceAssunto += 1;
          }
          if (indiceAssunto < palavras.length) quantidade = Math.max(quantidade, indiceAssunto + 1);
        }

        // Um resumo não deve acabar em conectivo, mesmo quando não há colisão.
        while (quantidade < palavras.length && palavrasDeLigacao.has(normalizarResumo(palavras[quantidade - 1]))) {
          quantidade += 1;
        }
        return { documento: item, palavras, quantidade };
      });

      // Expande apenas rótulos visualmente duplicados; conectivos finais são completados juntos.
      let houveExpansao = true;
      while (houveExpansao) {
        houveExpansao = false;
        const rotulos = entradas.map((entrada) => normalizarResumo(entrada.palavras.slice(0, entrada.quantidade).join(' ')));
        entradas.forEach((entrada, indice) => {
          if (!rotulos[indice] || !rotulos.some((rotulo, outroIndice) => outroIndice !== indice && rotulo === rotulos[indice])) return;
          if (entrada.quantidade >= entrada.palavras.length) return;
          entrada.quantidade += 1;
          while (entrada.quantidade < entrada.palavras.length &&
            palavrasDeLigacao.has(normalizarResumo(entrada.palavras[entrada.quantidade - 1]))) {
            entrada.quantidade += 1;
          }
          houveExpansao = true;
        });
      }

      // A listagem aplica dados de apresentação com spread e cria clones dos documentos.
      const entradaAtual = entradas.find((entrada) => entrada.documento === doc) ||
        (doc.id != null ? entradas.find((entrada) => entrada.documento.id === doc.id) : null);
      if (!entradaAtual || entradaAtual.palavras.length === 0) return '-';
      return entradaAtual.palavras.slice(0, entradaAtual.quantidade).join(' ');
    },

    exportarCSV() {
      const docs = this.filteredDocumentos;
      if (docs.length === 0) {
        alert("Nenhum documento encontrado com os filtros atuais.");
        return;
      }

      let csv = "Apelido;Orgao Expedidor;Categoria;Vencimento;Dias Restantes;Status\n";

      docs.forEach(doc => {
        const apelido = this.nomeDocumento(doc);
        const orgao = doc.orgao_expeditor || doc.orgaoExpeditor || '-';
        const categoria = doc.categoria || '-';
        const vencimento = this.formatDate(doc.vencimento);
        const dias = doc.is_vitalicio ? 'Vitalicio' : (doc.dias_restantes != null ? doc.dias_restantes : (doc.diasRestantes != null ? doc.diasRestantes : '-'));
        const status = this.labelStatus(doc);

        const linha = [apelido, orgao, categoria, vencimento, dias, status]
          .map(campo => '"' + String(campo).split('"').join('""') + '"')
          .join(';');

        csv += linha + "\n";
      });

      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `Controle_Documentos_${new Date().toISOString().split('T')[0]}.csv`;

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      this.showExportModal = false;
    },

    // --- MOTOR DE EXPORTAÇÃO WHATSAPP ---
    exportarWhatsApp() {
      const categorias = this.resumoCategorias;
      if (categorias.length === 0) {
        alert("Nenhum dado encontrado para partilhar.");
        return;
      }

      let textoRelatorio = "*Resumo de Documentações por Categoria* 📊\n\n";

      categorias.forEach(cat => {
        textoRelatorio += `*${cat.categoria}*\n`;
        textoRelatorio += `🔴 Atrasado: ${cat.vencido} | 🟡 Breve: ${cat.venceEmBreve} | 🟢 OK: ${cat.emDia}\n\n`;
      });

      textoRelatorio += `_Total filtrado: ${this.stats.total} documento(s)_`;

      window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(textoRelatorio)}`, '_blank');
      this.showExportModal = false;
    },

    scrollToLista(status) {
      this.statusFilter = status;
      document.getElementById('documentos-section').scrollIntoView({ behavior: 'smooth' });
    },

    // --- LÓGICA REATIVA DE FILTRAGEM ---
    get filteredDocumentos() {
      const pesos = { 'vencido': 1, 'vence_em_breve': 2, 'em_dia': 3 };

      return this.documentos.filter(doc => {
        const textoBusca = (doc.apelido || doc.documento || '') + ' ' + (doc.orgao_expeditor || doc.orgaoExpeditor || '') + ' ' + (doc.categoria || '') + ' ' + (doc.tipo_doc || doc.tipo_documento || doc.tipoDocumento || '');
        const bateBusca = textoBusca.toLowerCase().includes(this.search.toLowerCase());
        const status = this.statusResumo(doc);
        const bateStatus = !this.statusFilter || status === this.statusFilter;
        const bateCategoria = !this.categoriaFilter || doc.categoria === this.categoriaFilter;
        return bateBusca && bateStatus && bateCategoria;
      }).sort((a, b) => {
        const statusA = this.statusResumo(a);
        const statusB = this.statusResumo(b);
        const pesoA = pesos[statusA] || 4;
        const pesoB = pesos[statusB] || 4;

        if (pesoA !== pesoB) return pesoA - pesoB;

        const getDias = (d) => d.is_vitalicio ? 999999 : (this.getDiasRestantes(d) != null ? this.getDiasRestantes(d) : 999999);
        return getDias(a) - getDias(b);
      });
    },

    get documentosVisiveisNaListagem() {
      return this.filteredDocumentos;
    },

    statusResumoGeral(doc) {
      return this.statusResumo(doc);
    },

    get stats() {
      const listaBase = this.filteredDocumentos;
      return {
        total: listaBase.length,
        emDia: listaBase.filter(d => this.statusResumo(d) === 'em_dia').length,
        venceEmBreve: listaBase.filter(d => this.statusResumo(d) === 'vence_em_breve').length,
        vencido: listaBase.filter(d => this.statusResumo(d) === 'vencido').length
      };
    },

    get resumoGeralStats() {
      const documentos = this.documentos;
      const total = documentos.length;
      const vencido = documentos.filter((doc) => this.statusResumoGeral(doc) === 'vencido').length;
      const venceEmBreve = documentos.filter((doc) => this.statusResumoGeral(doc) === 'vence_em_breve').length;
      const emDia = documentos.filter((doc) => this.statusResumoGeral(doc) === 'em_dia').length;
      return { total, vencido, venceEmBreve, emDia };
    },

    get categoriasUnicas() {
      return [...new Set(this.documentos.map(d => d.categoria).filter(Boolean))].sort();
    },

    get resumoCategorias() {
      const mapa = {};

      this.filteredDocumentos.forEach(doc => {
        const categoriaOriginal = String(doc.categoria || 'Sem categoria').trim().replace(/\s+/g, ' ');
        const chaveCategoria = categoriaOriginal
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLocaleLowerCase('pt-BR');
        if (chaveCategoria === 'sem categoria') return;

        const categoriaExibida = chaveCategoria === 'juridico' ? 'Jurídico' : categoriaOriginal;
        const status = this.statusResumoGeral(doc);

        if (!mapa[chaveCategoria]) {
          mapa[chaveCategoria] = { categoria: categoriaExibida, total: 0, emDia: 0, venceEmBreve: 0, vencido: 0 };
        }

        mapa[chaveCategoria].total++;
        if (status === 'em_dia') mapa[chaveCategoria].emDia++;
        if (status === 'vence_em_breve') mapa[chaveCategoria].venceEmBreve++;
        if (status === 'vencido') mapa[chaveCategoria].vencido++;
      });

      return Object.values(mapa).sort((a, b) => b.total - a.total);
    },

    labelStatusValue(status) {
      if (status === 'vencido') return 'Vencido';
      if (status === 'vence_em_breve') return 'Prestes a vencer';
      if (status === 'em_dia') return 'Em dia';
      return '-';
    },

    textoNotificacaoRapida(item) {
      if (!item) return '-';
      if (item.tipo_evento === 'vencido') {
        const diasVencidos = Math.abs(Number(item.dias_restantes));
        return `Vencido h\u00e1 ${diasVencidos} dia${diasVencidos === 1 ? '' : 's'}.`;
      }
      if (item.tipo_evento === 'vence_em_breve') {
        const diasRestantes = Number(item.dias_restantes);
        if (diasRestantes === 0) return 'Vence hoje.';
        return `Vence em ${diasRestantes} dia${diasRestantes === 1 ? '' : 's'}.`;
      }
      if (item.tipo_evento === 'vence_hoje') return 'Hoje é o último dia para renovação deste documento.';

      const statusAnterior = this.labelStatusValue(item.status_anterior);
      const statusNovo = this.labelStatusValue(item.status_novo);

      if (statusAnterior !== '-' && statusNovo !== '-' && statusAnterior !== statusNovo) {
        return `Mudou de ${statusAnterior} para ${statusNovo}.`;
      }

      if (statusNovo !== '-') {
        return `Status alterado para ${statusNovo}.`;
      }

      return 'O status deste documento foi atualizado.';
    },

    async openNotificationDocument(item) {
      if (!item || !item.documento_id) return;
      const documento = this.documentos.find((doc) => String(doc.id) === String(item.documento_id));

      if (!documento) return;

      this.marcarNotificacaoComoLida(item);
      this.showNotificationsPanel = false;

      await this.$nextTick();
      this.selected = documento;
    },

    // --- HELPERS DE UI RESPONSIVA ---
    labelStatus(doc) {
      if (!doc) return '-';
      if (doc.is_vitalicio) return 'Vitalício';

      const status = this.statusResumo(doc);
      if (status === 'vencido') return 'Vencido';
      if (status === 'vence_em_breve') return 'Prestes a vencer';
      return 'Em dia';
    },

    badgeClass(doc) {
      if (!doc) return '';
      if (doc.is_vitalicio) return 'bg-blue-100 text-blue-700';

      const status = this.statusResumo(doc);
      if (status === 'vencido') return 'bg-rose-100 text-rose-700';
      if (status === 'vence_em_breve') return 'bg-amber-100 text-amber-700';
      return 'bg-emerald-100 text-emerald-700';
    },

    urgenciaDiasClass(doc) {
      if (!doc) return '';
      if (doc.is_vitalicio) return 'text-blue-700 font-medium';

      const status = this.statusResumo(doc);
      if (status === 'vencido') return 'text-rose-700 font-bold';
      if (status === 'vence_em_breve') return 'text-amber-700 font-bold';
      return 'text-slate-800 font-medium';
    },

    formatDias(doc) {
      if (!doc) return '-';
      if (doc.is_vitalicio) return 'Vitalício';

      const dias = this.getDiasRestantes(doc);
      return dias != null ? dias : '-';
    },

    formatDiasTexto(doc) {
      if (!doc) return '-';
      if (doc.is_vitalicio) return 'Vitalício (Não vence)';

      const dias = this.getDiasRestantes(doc);
      if (dias == null) return '-';
      if (dias === 0) return 'Vence hoje';
      if (dias < 0) return `${Math.abs(dias)} dia(s) em atraso`;
      return `${dias} dias restantes`;
    },

    formatDate(date) {
      if (!date) return '-';
      if (String(date).includes('2999')) return 'Vitalício';

      const partes = String(date).split('-');
      if (partes.length === 3) return `${partes[2].slice(0, 2)}/${partes[1]}/${partes[0]}`;

      const parsed = this.parseDate(date);
      if (!parsed) return '-';

      const dia = String(parsed.getDate()).padStart(2, '0');
      const mes = String(parsed.getMonth() + 1).padStart(2, '0');
      const ano = parsed.getFullYear();
      return `${dia}/${mes}/${ano}`;
    }
  }));
});
