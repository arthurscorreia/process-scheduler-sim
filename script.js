document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('iniciar-simulacao').addEventListener('click', iniciarSimulacao);
});


class Processo {
    constructor(p) {
        this.id = p.id;
        this.chegada = p.chegada;
        this.execucaoTotal = p.execucao;
        this.deadline = p.deadline;
        this.prioridade = p.prioridade;
        
        this.restante = p.execucao;
        this.vruntime = p.vruntime ?? 0; 
        this.inicio = []; 
        this.termino = 0;
        this.espera = 0;
        this.turnaround = 0;

        // seq: número que preserva a ordem original do input (tie-breaker determinístico)
        this.seq = p.seq ?? p.__seq ?? 0;
    }
}


class Simulador {
    constructor(config) {
        this.algoritmo = config.algoritmo;
        this.quantum = config.quantum;
        this.sobrecarga = config.sobrecarga;
        
        this.processosOriginais = config.processos; 
        this.processos = []; 
        this.filaDeProntos = [];
        this.filaDeEventos = []; 
        
        this.tempoAtual = 0;
        this.cpuOciosa = true;
        this.processoNaCPU = null;
        
        this.tempoOciosoTotal = 0;
        this.totalTrocasContexto = 0;
        this.logGantt = [];
    }

    run() {
        console.log(`Iniciando simulação com ${this.algoritmo}...`);
        
        this.processos = [];
        this.filaDeProntos = [];
        this.filaDeEventos = [];
        this.tempoAtual = 0;
        this.cpuOciosa = true;
        this.processoNaCPU = null;
        this.tempoOciosoTotal = 0;
        this.totalTrocasContexto = 0;
        this.logGantt = [];

        // Atribuir seq a cada processo na ordem do input (preserva P1,P2,... em empates).
        for (let i = 0; i < this.processosOriginais.length; i++) {
            this.processosOriginais[i].__seq = i;
        }

        for (const p of this.processosOriginais) {
            this.adicionarEvento(p.chegada, 'CHEGADA', p);
        }

        while (this.filaDeEventos.length > 0) {
            const proximoEvento = this.filaDeEventos[0];
            const tempoCorrente = proximoEvento.tempo;

            if (tempoCorrente > this.tempoAtual) {
                if (this.cpuOciosa) {
                    this.logGantt.push({ id: 'OCIOSO', inicio: this.tempoAtual, fim: tempoCorrente, tipo: 'ocioso' });
                    this.tempoOciosoTotal += (tempoCorrente - this.tempoAtual);
                }
                this.tempoAtual = tempoCorrente;
            }

            while (this.filaDeEventos.length > 0 && this.filaDeEventos[0].tempo === this.tempoAtual) {
                const evento = this.filaDeEventos.shift();
                this.processarEvento(evento);
            }

            if (this.cpuOciosa && this.filaDeProntos.length > 0) {
                this.alocarCPU();
            }
        }
        
        this.calcularMetricasFinais();
        this.renderizarResultados();
    }

    // Inserção estável: eventos com mesmo tempo são colocados *após* os já existentes,
    // preservando a ordem de criação.
    adicionarEvento(tempo, tipo, dados) {
        const evento = { tempo, tipo, dados };
        let i = 0;
        // Usar <= garante que novos eventos com mesmo tempo sejam inseridos depois
        // dos existentes, mantendo a ordem original de chegadas.
        while (i < this.filaDeEventos.length && this.filaDeEventos[i].tempo <= tempo) {
            i++;
        }
        this.filaDeEventos.splice(i, 0, evento);
    }

    processarEvento(evento) {
        console.log(`[T=${this.tempoAtual}] Evento: ${evento.tipo} | Dados: ${evento.dados?.id || '-'}`);
        
        switch (evento.tipo) {
            case 'CHEGADA':
                this.handleChegada(evento.dados);
                break;
            case 'FIM_EXECUCAO':
                this.handleFimExecucao(evento.dados);
                break;
            case 'FIM_QUANTUM':
                this.handleFimQuantum(evento.dados);
                break;
            case 'FIM_SOBRECARGA':
                this.handleFimSobrecarga(evento.dados);
                break;
        }
    }


    handleChegada(dadosProcesso) {
        // Certifica-se de propagar seq para o Processo
        const novoDados = Object.assign({}, dadosProcesso);
        novoDados.__seq = novoDados.__seq ?? novoDados.seq ?? 0;

        const novoProcesso = new Processo(novoDados);
        
        if (this.algoritmo === 'CFS') {
            // Inicialização de vruntime: use seq + tempoAtual para determinismo em empates
            novoProcesso.vruntime = this.tempoAtual + (novoProcesso.seq * 1e-6);
        }
        
        this.processos.push(novoProcesso); 
        this.filaDeProntos.push(novoProcesso); 
        
        if (!this.cpuOciosa && this.processoNaCPU) {
            if (this.devePreemptar(novoProcesso)) {
                console.warn(`PREEMPÇÃO NECESSÁRIA por ${novoProcesso.id} (não preemptivo completo)`);
                // Nota: lógica de preempção não implementada por completo — manter como aviso.
            }
        }
    }

    /**
     * Manipulador: Processo terminou sua execução
     * NOTA: NÃO chama iniciarTrocaContexto aqui — término NÃO é sobrecarga.
     */
    handleFimExecucao(processo) {
        processo.termino = this.tempoAtual;
        
        const inicioExecucao = processo.inicio.slice(-1)[0];
        this.logarExecucaoGantt(processo, inicioExecucao, this.tempoAtual);

        this.processoNaCPU = null;
        this.cpuOciosa = true; // Libera a CPU
    }

    /**
     * Manipulador: Quantum do Round-Robin expirou (PREEMPÇÃO)
     */
    handleFimQuantum(processo) {
        const inicioExecucao = processo.inicio.slice(-1)[0];
        this.logarExecucaoGantt(processo, inicioExecucao, this.tempoAtual);
        
        this.filaDeProntos.push(processo);
        this.processoNaCPU = null;
        this.cpuOciosa = true; // Libera a CPU para a troca de contexto

        // Inicia a troca de contexto — MOD: passa o processo que foi interrompido
        this.iniciarTrocaContexto(processo);
    }

    /**
     * Inicia a sobrecarga da troca de contexto
     * MOD: recebe opcionalmente o processo interrompido (interrompido).
     * Se recebido, marca a sobrecarga na linha desse processo (id = processo.id).
     * Caso contrário, preserva comportamento antigo (id = 'SC').
     */
    iniciarTrocaContexto(interrompido = null) {
        if (this.filaDeProntos.length > 0 && this.sobrecarga > 0) {
            this.totalTrocasContexto++;
            this.cpuOciosa = false; // CPU ocupada com a sobrecarga

            if (interrompido && interrompido.id) {
                // MOD: registrar sobrecarga na linha do processo interrompido
                this.logGantt.push({
                    id: interrompido.id, 
                    inicio: this.tempoAtual, 
                    fim: this.tempoAtual + this.sobrecarga, 
                    tipo: 'sobrecarga' // Será pintado como gantt-sobrecarga (vermelho)
                });
            } else {
                // fallback: bloco genérico SC (linha separada)
                this.logGantt.push({ 
                    id: 'SC', 
                    inicio: this.tempoAtual, 
                    fim: this.tempoAtual + this.sobrecarga, 
                    tipo: 'sobrecarga' 
                });
            }

            this.adicionarEvento(this.tempoAtual + this.sobrecarga, 'FIM_SOBRECARGA', {});
        }
        // Se não houver sobrecarga, a CPU permanece ociosa e o loop chamará alocarCPU()
    }
    
    /**
     * Manipulador: A sobrecarga de contexto terminou
     */
    handleFimSobrecarga(dados) {
        this.cpuOciosa = true; // Libera a CPU
        // O loop 'run' chamará alocarCPU()
    }

    // Helper: extrai número do id P1 -> 1; se não encontrar, retorna seq
    idNumber(proc) {
        if (!proc || !proc.id) return proc.seq ?? 0;
        const m = proc.id.match(/(\d+)$/);
        if (m) return parseInt(m[1], 10);
        return proc.seq ?? 0;
    }

    // Comparador robusto com tie-breakers: prioridade, chegada, seq / idNumber
    compareBySeq(a, b) {
        return (a.seq ?? 0) - (b.seq ?? 0);
    }

    /**
     * Decide qual processo da fila de prontos irá para a CPU
     */
    escalonarProximoProcesso() {
        if (this.filaDeProntos.length === 0) return null;

        let proximoProcesso;

        switch (this.algoritmo) {
            case 'FIFO':
                // Ordena por tempo de chegada; em empate, usa seq (ordem de input)
                this.filaDeProntos.sort((a, b) => {
                    if (a.chegada !== b.chegada) return a.chegada - b.chegada;
                    return this.compareBySeq(a, b);
                });
                proximoProcesso = this.filaDeProntos.shift();
                break;
            case 'SJF':
                // Ordena por tempo de execução TOTAL (não preemptivo).
                // Empate por chegada, depois seq.
                this.filaDeProntos.sort((a, b) => {
                    if (a.execucaoTotal !== b.execucaoTotal) return a.execucaoTotal - b.execucaoTotal;
                    if (a.chegada !== b.chegada) return a.chegada - b.chegada;
                    return this.compareBySeq(a, b);
                });
                proximoProcesso = this.filaDeProntos.shift();
                break;
            case 'RR':
                // RR preserva ordem FIFO da fila; shift é suficiente.
                proximoProcesso = this.filaDeProntos.shift();
                break;
            case 'EDF':
                // Ordena por deadline; empates por chegada, depois seq.
                this.filaDeProntos.sort((a, b) => {
                    if (a.deadline !== b.deadline) return a.deadline - b.deadline;
                    if (a.chegada !== b.chegada) return a.chegada - b.chegada;
                    return this.compareBySeq(a, b);
                });
                proximoProcesso = this.filaDeProntos.shift();
                break;
            case 'CFS':
                // Ordena por vruntime; empates por prioridade (lower better?), depois seq.
                this.filaDeProntos.sort((a, b) => {
                    if (a.vruntime !== b.vruntime) return a.vruntime - b.vruntime;
                    if (a.prioridade !== b.prioridade) return a.prioridade - b.prioridade;
                    return this.compareBySeq(a, b);
                });
                proximoProcesso = this.filaDeProntos.shift();
                break;
            default:
                // Default: FIFO semantics
                proximoProcesso = this.filaDeProntos.shift();
        }
        return proximoProcesso;
    }

    /**
     * Aloca a CPU a um processo, se possível
     */
    alocarCPU() {
        if (!this.cpuOciosa || this.filaDeProntos.length === 0) {
            return;
        }

        const processo = this.escalonarProximoProcesso();
        if (!processo) {
            this.cpuOciosa = true; // Ninguém na fila
            return;
        }

        this.cpuOciosa = false;
        this.processoNaCPU = processo;
        processo.inicio.push(this.tempoAtual);
        
        let tempoExecucao = 0;

        switch (this.algoritmo) {
            case 'FIFO':
            case 'SJF':
            case 'EDF': 
                tempoExecucao = processo.restante;
                processo.restante = 0;
                this.adicionarEvento(this.tempoAtual + tempoExecucao, 'FIM_EXECUCAO', processo);
                break;
            case 'RR':
                tempoExecucao = Math.min(processo.restante, this.quantum);
                processo.restante -= tempoExecucao;
                if (processo.restante > 0) {
                    this.adicionarEvento(this.tempoAtual + tempoExecucao, 'FIM_QUANTUM', processo);
                } else {
                    this.adicionarEvento(this.tempoAtual + tempoExecucao, 'FIM_EXECUCAO', processo);
                }
                break;
            case 'CFS':
                const fatiaGranular = 1; 
                tempoExecucao = Math.min(processo.restante, fatiaGranular);
                processo.restante -= tempoExecucao;

                // Weight baseado na prioridade (mantive sua fórmula)
                const w = Math.pow(1.25, processo.prioridade - 1); 
                processo.vruntime += tempoExecucao * w;
                
                if (processo.restante > 0) {
                     // Tratamos como quantum curto (fatia), re-insere na fila de prontos ao fim do quantum
                     // mas usamos evento FIM_QUANTUM para indicar interrupção da fatia.
                     this.adicionarEvento(this.tempoAtual + tempoExecucao, 'FIM_QUANTUM', processo); 
                } else {
                    this.adicionarEvento(this.tempoAtual + tempoExecucao, 'FIM_EXECUCAO', processo);
                }
                break;
        }
    }
    
    /**
     * Verifica se um novo processo deve preemptar o atual
     */
    devePreemptar(novoProcesso) {
        if (!this.processoNaCPU) return false;

        switch (this.algoritmo) {
            case 'EDF':
                if (novoProcesso.deadline !== this.processoNaCPU.deadline) {
                    return novoProcesso.deadline < this.processoNaCPU.deadline;
                }
                // empates em deadline -> usa seq (menor seq = prioridade no empate)
                return (novoProcesso.seq ?? 0) < (this.processoNaCPU.seq ?? 0);
            case 'CFS':
                if (novoProcesso.vruntime !== this.processoNaCPU.vruntime) {
                    return novoProcesso.vruntime < this.processoNaCPU.vruntime;
                }
                // empates em vruntime -> comparar prioridade
                if (novoProcesso.prioridade !== this.processoNaCPU.prioridade) {
                    return novoProcesso.prioridade < this.processoNaCPU.prioridade;
                }
                // empates finais -> seq
                return (novoProcesso.seq ?? 0) < (this.processoNaCPU.seq ?? 0);
        }
        return false;
    }

    /**
     * Registra um bloco de execução no Gantt, dividindo-o se
     * ele cruzar a deadline.
     */
    logarExecucaoGantt(processo, inicioExecucao, fimExecucao) {
        const deadline = processo.deadline;

        if (inicioExecucao >= deadline) {
            this.logGantt.push({ 
                id: processo.id, 
                inicio: inicioExecucao, 
                fim: fimExecucao, 
                tipo: 'estouro' // Cinza
            });
        }
        else if (fimExecucao > deadline) {
            this.logGantt.push({ 
                id: processo.id, 
                inicio: inicioExecucao, 
                fim: deadline, 
                tipo: 'execucao' // Verde
            });
            this.logGantt.push({ 
                id: processo.id, 
                inicio: deadline, 
                fim: fimExecucao, 
                tipo: 'estouro' // Cinza
            });
        }
        else {
            this.logGantt.push({ 
                id: processo.id, 
                inicio: inicioExecucao, 
                fim: fimExecucao, 
                tipo: 'execucao' // Verde
            });
        }
    }

    /**
     * Calcula métricas finais após a simulação
     */
    calcularMetricasFinais() {
        for (const p of this.processos) {
            p.turnaround = p.termino - p.chegada;
            p.espera = p.turnaround - p.execucaoTotal;
        }
    }

    /**
     * Renderiza os resultados nas tabelas e no Gantt
     */
    renderizarResultados() {
        // 1. Limpa saídas anteriores
        const ganttContainer = document.getElementById('gantt-chart');
        const tabelaBody = document.getElementById('tabela-resultados').querySelector('tbody');
        const metricasGlobais = document.getElementById('metricas-globais');
        
        ganttContainer.innerHTML = '';
        tabelaBody.innerHTML = '';
        metricasGlobais.innerHTML = '';

        // 2. Renderiza o Gráfico de Gantt (versão em quadrados)
        const tempoTotal = this.tempoAtual;
        ganttContainer.innerHTML = "";

        // Cria grade: cada quadrado = 1 segundo
        const escala = 40; // tamanho do quadrado (px)
        const linhas = [...new Set(this.processos.map(p => p.id))]
        .sort((a, b) => {
            const numA = parseInt(a.replace(/\D/g, "")) || 0;
            const numB = parseInt(b.replace(/\D/g, "")) || 0;
            return numA - numB;
        });

        // linhas.push("OCIOSO"); 
        const largura = tempoTotal * escala;
        const altura = linhas.length * escala;
        ganttContainer.style.position = "relative";
        ganttContainer.style.width = largura + "px";
        ganttContainer.style.height = altura + "px";

        // Cria os quadrados da tabela
        for (let y = 0; y < linhas.length; y++) {
            const idProc = linhas[y];
            for (let t = 0; t < tempoTotal; t++) {
                // Define tipo padrão
                let tipo = "ocioso";
                let cor = "gantt-ocioso";
                let idTexto = "";

                // Procura bloco correspondente a este tempo
                const bloco = this.logGantt.find(l => t >= l.inicio && t < l.fim && (l.id === idProc || (idProc === "OCIOSO" && l.id === "OCIOSO")));
                if (bloco) {
                    tipo = bloco.tipo;
                    cor = `gantt-${tipo}`;
                    idTexto = (bloco.id !== "OCIOSO" && bloco.id !== "SC") ? bloco.id : "";
                }

                // Cria célula (quadrado)
                const cel = document.createElement("div");
                cel.className = `gantt-barra ${cor}`;
                cel.style.left = (t * escala) + "px";
                cel.style.top = (y * escala) + "px";
                cel.style.width = escala + "px";
                cel.style.height = escala + "px";
                cel.title = `${idProc} @ t=${t} (${tipo})`;
                
                const label = document.createElement("span");
                label.textContent = idTexto;
                cel.appendChild(label);

                ganttContainer.appendChild(cel);
            }
        }

        // Renderiza linha da deadline sobre as barras
        this.processos.forEach(p => {
            const idx = linhas.indexOf(p.id);
            if (idx >= 0) {
                const line = document.createElement("div");
                line.className = "gantt-deadline-line";
                line.style.left = (p.deadline * escala) + "px";
                line.style.top = (idx * escala) + "px";
                line.style.height = escala + "px";
                line.title = `Deadline ${p.id}: ${p.deadline}`;
                ganttContainer.appendChild(line);
            }
        });

        // 3. Renderiza a Tabela Final
        this.processos.sort((a,b) => a.id.localeCompare(b.id)); 
        
        for (const p of this.processos) {
            const row = tabelaBody.insertRow();
            const deadlineOk = p.termino <= p.deadline;
            
            row.innerHTML = `
                <td>${p.id}</td>
                <td>${p.chegada}</td>
                <td>${p.execucaoTotal}</td>
                <td>${p.deadline}</td>
                <td>${p.prioridade}</td>
                <td>${p.inicio.join(', ')}</td>
                <td>${p.termino}</td>
                <td>${(p.espera ?? 0).toFixed(2)}</td>
                <td>${(p.turnaround ?? 0).toFixed(2)}</td>
                <td style="color: ${deadlineOk ? 'green' : 'red'}">${deadlineOk ? 'Sim' : 'NÃO'}</td>
            `;
        }

        // 4. Renderiza Métricas Globais
        const mediaTurnaround = this.processos.reduce((s, p) => s + (p.turnaround ?? 0), 0) / this.processos.length;
        const mediaEspera = this.processos.reduce((s, p) => s + (p.espera ?? 0), 0) / this.processos.length;
        const throughput = this.processos.length / this.tempoAtual;
        const percOcioso = (this.tempoOciosoTotal / this.tempoAtual) * 100;

        metricasGlobais.innerHTML = `
            <p><strong>Tempo total:</strong> ${this.tempoAtual.toFixed(2)} u.t.</p>
            <p><strong>Turnaround Médio:</strong> ${mediaTurnaround.toFixed(2)} u.t.</p>
            <p><strong>Tempo de Espera Médio:</strong> ${mediaEspera.toFixed(2)} u.t.</p>
            <p><strong>Throughput:</strong> ${throughput.toFixed(3)} processos/u.t.</p>
            <p><strong>% CPU Ociosa:</strong> ${percOcioso.toFixed(2)}%</p>
            <p><strong>Total de Trocas de Contexto:</strong> ${this.totalTrocasContexto}
        `;
    }
}

/**
 * Função principal que é chamada pelo botão
 */
function iniciarSimulacao() {
    // 1. Coletar dados da UI
    const algoritmo = document.getElementById('algoritmo').value;
    const quantum = parseInt(document.getElementById('quantum').value, 10);
    const sobrecarga = parseInt(document.getElementById('sobrecarga').value, 10);
    
    let processosInput;
    try {
        processosInput = JSON.parse(document.getElementById('processos-input').value);

        // Valida formato
        if (!processosInput.processos || !Array.isArray(processosInput.processos) || processosInput.processos.length === 0) {
            alert("O JSON deve conter um array 'processos' com pelo menos um processo.");
            return;
        }
    } catch (e) {
        alert("Erro no formato JSON dos processos!");
        return;
    }

    // 2. Montar objeto de configuração
    const config = {
        algoritmo: algoritmo,
        quantum: quantum,
        sobrecarga: sobrecarga,
        processos: processosInput.processos
    };

    // 3. Criar e rodar o simulador
    const sim = new Simulador(config);
    sim.run();
}
