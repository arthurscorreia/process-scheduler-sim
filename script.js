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


    adicionarEvento(tempo, tipo, dados) { // adiciona o evento na fila ordenada
        const evento = { tempo, tipo, dados };
        let i = 0;
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
        const novoDados = Object.assign({}, dadosProcesso);
        novoDados.__seq = novoDados.__seq ?? novoDados.seq ?? 0;
        const novoProcesso = new Processo(novoDados);
        
        if (this.algoritmo === 'CFS') {
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

    handleFimExecucao(processo) { // gerencia o fim da execução
        processo.termino = this.tempoAtual;
        
        const inicioExecucao = processo.inicio.slice(-1)[0];
        this.logarExecucaoGantt(processo, inicioExecucao, this.tempoAtual);

        this.processoNaCPU = null;
        this.cpuOciosa = true;
    }

    handleFimQuantum(processo) { // gerencia o quantum
        const inicioExecucao = processo.inicio.slice(-1)[0];
        this.logarExecucaoGantt(processo, inicioExecucao, this.tempoAtual);
        
        this.filaDeProntos.push(processo);
        this.processoNaCPU = null;
        this.cpuOciosa = true;
        this.iniciarTrocaContexto(processo);
    }

    iniciarTrocaContexto(interrompido = null) { // troca de contexto
        if (this.filaDeProntos.length > 0 && this.sobrecarga > 0) {
            this.totalTrocasContexto++;
            this.cpuOciosa = false;

            if (interrompido && interrompido.id) {
                this.logGantt.push({
                    id: interrompido.id, 
                    inicio: this.tempoAtual, 
                    fim: this.tempoAtual + this.sobrecarga, 
                    tipo: 'sobrecarga'
                });
            } else {
                this.logGantt.push({ 
                    id: 'SC', 
                    inicio: this.tempoAtual, 
                    fim: this.tempoAtual + this.sobrecarga, 
                    tipo: 'sobrecarga' 
                });
            }

            this.adicionarEvento(this.tempoAtual + this.sobrecarga, 'FIM_SOBRECARGA', {});
        }
    }
    
    handleFimSobrecarga(dados) {
        this.cpuOciosa = true;
    }

    idNumber(proc) {
        if (!proc || !proc.id) return proc.seq ?? 0;
        const m = proc.id.match(/(\d+)$/);
        if (m) return parseInt(m[1], 10);
        return proc.seq ?? 0;
    }

    compareBySeq(a, b) {
        return (a.seq ?? 0) - (b.seq ?? 0);
    }

    escalonarProximoProcesso() {
        if (this.filaDeProntos.length === 0) return null;

        let proximoProcesso;

        switch (this.algoritmo) {
            case 'FIFO': // ordena por chegada -> com base no seq (p1, p2, ...)
                this.filaDeProntos.sort((a, b) => {
                    if (a.chegada !== b.chegada) return a.chegada - b.chegada;
                    return this.compareBySeq(a, b);
                });
                proximoProcesso = this.filaDeProntos.shift();
                break;
            case 'SJF': // ordena por tempo de execução total -> chegada -> seq
                this.filaDeProntos.sort((a, b) => {
                    if (a.execucaoTotal !== b.execucaoTotal) return a.execucaoTotal - b.execucaoTotal;
                    if (a.chegada !== b.chegada) return a.chegada - b.chegada;
                    return this.compareBySeq(a, b);
                });
                proximoProcesso = this.filaDeProntos.shift();
                break;
            case 'RR': // preemptivo por quantum, fila circular
                proximoProcesso = this.filaDeProntos.shift();
                break;
            case 'EDF': // ordena por deadline mais proximo
                this.filaDeProntos.sort((a, b) => {
                    if (a.deadline !== b.deadline) return a.deadline - b.deadline;
                    if (a.chegada !== b.chegada) return a.chegada - b.chegada;
                    return this.compareBySeq(a, b);
                });
                proximoProcesso = this.filaDeProntos.shift();
                break;
            case 'CFS': // ordena por vruntime
                this.filaDeProntos.sort((a, b) => {
                    if (a.vruntime !== b.vruntime) return a.vruntime - b.vruntime;
                    if (a.prioridade !== b.prioridade) return a.prioridade - b.prioridade;
                    return this.compareBySeq(a, b);
                });
                proximoProcesso = this.filaDeProntos.shift();
                break;
            default:
                proximoProcesso = this.filaDeProntos.shift();
        }
        return proximoProcesso;
    }

    alocarCPU() { // aloca CPU ao próximo processo
        if (!this.cpuOciosa || this.filaDeProntos.length === 0) {
            return;
        }

        const processo = this.escalonarProximoProcesso();
        if (!processo) {
            this.cpuOciosa = true;
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

                const w = Math.pow(1.25, processo.prioridade - 1); 
                processo.vruntime += tempoExecucao * w;
                
                if (processo.restante > 0) {
                     this.adicionarEvento(this.tempoAtual + tempoExecucao, 'FIM_QUANTUM', processo); 
                } else {
                    this.adicionarEvento(this.tempoAtual + tempoExecucao, 'FIM_EXECUCAO', processo);
                }
                break;
        }
    }
    
    devePreemptar(novoProcesso) { // verifica a preempsao
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

    calcularMetricasFinais() {
        for (const p of this.processos) {
            p.turnaround = p.termino - p.chegada;
            p.espera = p.turnaround - p.execucaoTotal;
        }
    }

    renderizarResultados() { // renderiza os resultados 
        const ganttContainer = document.getElementById('gantt-chart');
        const tabelaBody = document.getElementById('tabela-resultados').querySelector('tbody');
        const metricasGlobais = document.getElementById('metricas-globais');
        
        ganttContainer.innerHTML = '';
        tabelaBody.innerHTML = '';
        metricasGlobais.innerHTML = '';

        // renderiza o Gráfico de Gantt
        const tempoTotal = this.tempoAtual;
        ganttContainer.innerHTML = "";

        // cria grade: cada quadrado = 1 segundo
        const escala = 40; // tamanho do quadrado 
        const linhas = [...new Set(this.processos.map(p => p.id))]
        .sort((a, b) => {
            const numA = parseInt(a.replace(/\D/g, "")) || 0;
            const numB = parseInt(b.replace(/\D/g, "")) || 0;
            return numA - numB;
        });

        const largura = tempoTotal * escala;
        const altura = linhas.length * escala;
        ganttContainer.style.position = "relative";
        ganttContainer.style.width = largura + "px";
        ganttContainer.style.height = altura + "px";

        // cria os quadrados da tabela
        for (let y = 0; y < linhas.length; y++) {
            const idProc = linhas[y];
            for (let t = 0; t < tempoTotal; t++) {
                let tipo = "ocioso";
                let cor = "gantt-ocioso";
                let idTexto = "";

                const bloco = this.logGantt.find(l => t >= l.inicio && t < l.fim && (l.id === idProc || (idProc === "OCIOSO" && l.id === "OCIOSO")));
                if (bloco) {
                    tipo = bloco.tipo;
                    cor = `gantt-${tipo}`;
                    idTexto = (bloco.id !== "OCIOSO" && bloco.id !== "SC") ? bloco.id : "";
                }

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

        // renderiza a tabela final
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
                <td style="color: ${deadlineOk ? 'green' : 'red'}">${deadlineOk ? 'Sim' : 'Não'}</td>
            `;
        }

        // renderiza métricas
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


function iniciarSimulacao() {
    // coletaa dados
    const algoritmo = document.getElementById('algoritmo').value;
    const quantum = parseInt(document.getElementById('quantum').value, 10);
    const sobrecarga = parseInt(document.getElementById('sobrecarga').value, 10);
    
    let processosInput;
    try {
        processosInput = JSON.parse(document.getElementById('processos-input').value);

        // verifca o formato json
        if (!processosInput.processos || !Array.isArray(processosInput.processos) || processosInput.processos.length === 0) {
            alert("O JSON deve conter um array 'processos' com pelo menos um processo.");
            return;
        }
    } catch (e) {
        alert("Erro no formato JSON dos processos!");
        return;
    }

    const config = {
        algoritmo: algoritmo,
        quantum: quantum,
        sobrecarga: sobrecarga,
        processos: processosInput.processos
    };

    // roda o simulador
    const sim = new Simulador(config);
    sim.run();
}
