window.AppModules = window.AppModules || {};

window.AppModules.jobDetail = {
  state() {
    return {
      showJobDetail: false,
      jobDetail: null,
      jobDetailChildJobs: [],
      jobDetailApprovals: [],
      jobDebug: null,
      jobDebugLoading: false,
      jobDebugError: '',
      jobDetailLoading: false,
      jobDetailError: '',
      jobDetailRefreshTimer: null,
    };
  },

  methods: {
    async openJobDetail(jobOrId) {
      const id = typeof jobOrId === 'string' ? jobOrId : jobOrId?.id;
      if (!id) return;
      this.showJobDetail = true;
      this.jobDetail = typeof jobOrId === 'object' ? jobOrId : null;
      this.jobDetailChildJobs = [];
      this.jobDetailApprovals = [];
      this.jobDebug = null;
      this.jobDebugError = '';
      this.jobDetailError = '';
      this.jobDetailLoading = true;
      try {
        const r = await fetch(`api/queue/${encodeURIComponent(id)}`);
        const data = await r.json();
        if (!r.ok) { this.jobDetailError = data.error || 'Job not found'; return; }
        this.markApiOk();
        this.jobDetail = data;
        await this.loadJobDetailWorkflowContext(id);
        await this.loadJobDebugger(id);
        this.syncJobDetailRefresh();
      } catch (err) {
        this.jobDetailError = err.message;
        this.reportApiError('Job detail load failed', err);
      } finally {
        this.jobDetailLoading = false;
      }
    },

    closeJobDetail() {
      this.stopJobDetailRefresh();
      this.showJobDetail = false;
      this.jobDetail = null;
      this.jobDetailChildJobs = [];
      this.jobDetailApprovals = [];
      this.jobDebug = null;
      this.jobDebugError = '';
      this.jobDetailError = '';
    },

    async loadJobDebugger(jobId = this.jobDetail?.id) {
      if (!jobId) return;
      this.jobDebugLoading = true;
      this.jobDebugError = '';
      try {
        this.jobDebug = await this.apiJson(`api/queue/${encodeURIComponent(jobId)}/debug`, {}, 'Job debugger load failed');
      } catch (err) {
        this.jobDebug = null;
        this.jobDebugError = err.message;
      } finally {
        this.jobDebugLoading = false;
      }
    },

    async loadJobDetailWorkflowContext(jobId = this.jobDetail?.id) {
      if (!jobId) return;
      try {
        const [childrenData, approvalsData] = await Promise.all([
          this.apiJson(`api/queue?parentJobId=${encodeURIComponent(jobId)}&limit=120`, {}, 'Workflow child jobs load failed'),
          this.apiJson('api/approvals?limit=120', {}, 'Workflow approvals load failed'),
        ]);
        this.jobDetailChildJobs = childrenData.jobs || [];
        this.jobDetailApprovals = (approvalsData.approvals || []).filter(approval => approval.workflowJobId === jobId);
      } catch {
        // apiJson already reports the error; keep the primary job detail visible.
      }
    },

    async refreshJobDetail() {
      if (!this.jobDetail?.id || this.jobDetailLoading) return;
      await this.openJobDetail(this.jobDetail.id);
    },

    syncJobDetailRefresh() {
      this.stopJobDetailRefresh();
      if (this.showJobDetail && this.jobDetail && (this.jobDetail.workflow || this.workflowStepRows().length) && ['pending', 'running'].includes(this.jobDetail.status)) {
        this.jobDetailRefreshTimer = setInterval(() => this.refreshJobDetail(), 4000);
      }
    },

    stopJobDetailRefresh() {
      if (this.jobDetailRefreshTimer) {
        clearInterval(this.jobDetailRefreshTimer);
        this.jobDetailRefreshTimer = null;
      }
    },

    jobTitle(job = this.jobDetail) {
      if (!job) return 'Job';
      if (job.agent) return `${job.agent}${job.action ? ' / ' + job.action : ''}`;
      if (job.workflow) return `Workflow / ${job.workflow}`;
      if (job.command) return job.command.split('/').pop();
      return job.id;
    },

    jobResultText(job = this.jobDetail) {
      return job?.result?.textOutput || job?.result?.error || '';
    },

    isWorkflowJob(job = this.jobDetail) {
      return Boolean(job?.workflow || job?.result?.stepResults?.length || this.jobDetailChildJobs.length || this.jobDetailApprovals.length);
    },

    isAgentJob(job = this.jobDetail) {
      return Boolean(job?.agent || job?.prompt);
    },

    debuggerSummaryCards(job = this.jobDetail) {
      if (!job) return [];
      const inspector = this.runInspector();
      return [
        { label: 'Kind', value: inspector.identity?.kind || this.jobDebug?.kind || (this.isWorkflowJob(job) ? 'workflow' : this.isAgentJob(job) ? 'agent' : 'job') },
        { label: 'Mode', value: inspector.identity?.mode || job.mode || '-' },
        { label: 'Prompt', value: inspector.prompt?.chars ? `${this.formatNumber(inspector.prompt.chars)} chars` : (inspector.prompt?.error ? 'error' : '-') },
        { label: 'Output', value: inspector.result?.outputChars ? `${this.formatNumber(inspector.result.outputChars)} chars` : '-' },
      ];
    },

    runInspector() {
      return this.jobDebug?.inspector || {};
    },

    inspectorRequestRows(job = this.jobDetail) {
      const inspector = this.runInspector();
      const request = inspector.request || {};
      return [
        ['Agent', request.agent || job?.agent || '-'],
        ['Action', request.action || job?.action || '-'],
        ['Workflow', request.workflow || job?.workflow || '-'],
        ['Scope', request.scope || job?.scope || 'global'],
        ['Model', request.model || job?.result?.model || job?.model || '-'],
        ['Session', request.sessionId || job?.sessionId || '-'],
        ['Parent', inspector.identity?.parentJobId || job?.parentJobId || '-'],
      ];
    },

    inspectorTimingCards() {
      const timing = this.runInspector().timing || {};
      return [
        { label: 'Queue Wait', value: timing.queuedMs !== null && timing.queuedMs !== undefined ? this.formatDuration(timing.queuedMs) : '-' },
        { label: 'Runtime', value: timing.runtimeMs !== null && timing.runtimeMs !== undefined ? this.formatDuration(timing.runtimeMs) : '-' },
        { label: 'API Time', value: timing.apiMs !== null && timing.apiMs !== undefined ? this.formatDuration(timing.apiMs) : '-' },
        { label: 'Total', value: timing.totalMs !== null && timing.totalMs !== undefined ? this.formatDuration(timing.totalMs) : '-' },
      ];
    },

    inspectorWorkspaceRows() {
      const inspector = this.runInspector();
      const workspace = inspector.workspace || {};
      const routing = inspector.routing || {};
      const outputChannel = routing.outputChannel
        ? `${routing.outputChannel.platform || '-'}:${routing.outputChannel.id || '-'}`
        : '-';
      return [
        ['CWD', workspace.cwd || '-'],
        ['CWD exists', workspace.exists === true ? 'yes' : workspace.exists === false ? 'no' : '-'],
        ['Output', outputChannel],
        ['Thread', routing.threadId || '-'],
      ];
    },

    inspectorPromptSources() {
      return this.runInspector().prompt?.sources || [];
    },

    inspectorFiles() {
      return this.runInspector().files || [];
    },

    inspectorMemory() {
      return this.runInspector().memory || {};
    },

    inspectorMemoryCards() {
      const memory = this.inspectorMemory();
      const stats = memory.stats || {};
      return [
        { label: 'Backend', value: memory.backend || '-' },
        { label: 'Available', value: memory.available === true ? 'yes' : memory.available === false ? 'no' : '-' },
        { label: 'Memories', value: stats.totalMemories !== null && stats.totalMemories !== undefined ? this.formatNumber(stats.totalMemories) : '-' },
        { label: 'Recall Hits', value: memory.recall?.resultCount !== undefined ? this.formatNumber(memory.recall.resultCount) : '-' },
        { label: 'Recall Chars', value: memory.recall?.chars !== undefined ? this.formatNumber(memory.recall.chars) : '-' },
      ];
    },

    inspectorMemoryRows() {
      const memory = this.inspectorMemory();
      const stats = memory.stats || {};
      return [
        ['Config', memory.configPath || '-'],
        ['Command', memory.command || '-'],
        ['Query', memory.query || '-'],
        ['Bank', stats.banks || '-'],
        ['DB', stats.dbPath || '-'],
      ];
    },

    inspectorMemorySources() {
      return this.inspectorMemory().sources || [];
    },

    inspectorMemoryRecallText() {
      const memory = this.inspectorMemory();
      return memory.recall?.raw || memory.recall?.error || '';
    },

    inspectorTools() {
      return this.runInspector().tools || {};
    },

    inspectorToolCards() {
      const tools = this.inspectorTools();
      return [
        { label: 'Toolset', value: tools.requestedToolset || this.jobDetail?.toolset || '-' },
        { label: 'Allowed', value: tools.allowedTools?.length ? this.formatNumber(tools.allowedTools.length) : '-' },
        { label: 'Used', value: tools.used?.length ? this.formatNumber(tools.used.length) : '0' },
        { label: 'MCP', value: tools.mcpServers?.length ? this.formatNumber(tools.mcpServers.length) : '0' },
      ];
    },

    inspectorToolText(list) {
      return Array.isArray(list) && list.length ? list.join(', ') : '-';
    },

    inspectorChildRows() {
      return this.runInspector().children || [];
    },

    inspectorApprovalRows() {
      return this.runInspector().approvals || [];
    },

    inspectorStatusClass(ok) {
      if (ok === true) return 'border-emerald-900/70 text-emerald-300 bg-emerald-950/30';
      if (ok === false) return 'border-red-900/70 text-red-300 bg-red-950/30';
      return 'border-gray-800 text-gray-500 bg-gray-950';
    },

    agentDebuggerRows(job = this.jobDetail) {
      if (!job) return [];
      return [
        ['Agent', job.agent || (job.prompt ? 'Raw prompt' : '-')],
        ['Action', job.action || '-'],
        ['Scope', job.scope || 'global'],
        ['Toolset', job.toolset || '-'],
        ['Model', job.result?.model || job.model || '-'],
        ['Session', job.sessionId || '-'],
        ['Parent', job.parentJobId || '-'],
        ['Files', (job.files || []).join(', ') || '-'],
      ];
    },

    workflowDebuggerCards(job = this.jobDetail) {
      const rows = this.workflowStepRows(job);
      const failed = rows.filter(step => ['failed', 'denied', 'timed_out'].includes(step.progressStatus || step.status)).length;
      return [
        { label: 'Steps', value: this.formatNumber(rows.length) },
        { label: 'Settled', value: this.formatNumber(this.workflowSettledStepCount(rows)) },
        { label: 'Failures', value: this.formatNumber(failed) },
        { label: 'Children', value: this.formatNumber(this.jobDetailChildJobs.length) },
      ];
    },

    sessionHistoryRows() {
      return this.jobDebug?.sessionHistory || [];
    },

    jobPreview(job = this.jobDetail) {
      return job?.result?.preview || null;
    },

    previewSummaryCards(job = this.jobDetail) {
      const preview = this.jobPreview(job);
      if (!preview) return [];
      const workflowSteps = preview.workflow?.stepCount ?? preview.workflow?.steps?.length;
      return [
        { label: 'Result', value: preview.ok ? 'passed' : 'failed' },
        { label: 'Kind', value: preview.kind || '-' },
        { label: 'Prompt', value: preview.promptChars !== undefined ? `${this.formatNumber(preview.promptChars)} chars` : '-' },
        { label: 'Tools', value: preview.allowedTools?.length ? this.formatNumber(preview.allowedTools.length) : '-' },
        { label: 'Files', value: preview.files?.length ? this.formatNumber(preview.files.length) : '-' },
        { label: 'Steps', value: workflowSteps !== undefined ? this.formatNumber(workflowSteps) : '-' },
      ];
    },

    previewValidationRows(job = this.jobDetail) {
      const preview = this.jobPreview(job);
      if (!preview) return [];
      return [
        ...(preview.errors || []).map(message => ({ type: 'error', message })),
        ...(preview.warnings || []).map(message => ({ type: 'warning', message })),
      ];
    },

    previewFileRows(job = this.jobDetail) {
      return this.jobPreview(job)?.files || [];
    },

    previewWorkflowRows(job = this.jobDetail) {
      return this.jobPreview(job)?.workflow?.steps || [];
    },

    previewOutputChannelText(job = this.jobDetail) {
      const channel = this.jobPreview(job)?.outputChannel;
      if (!channel) return '-';
      if (typeof channel === 'string') return channel;
      return [channel.platform, channel.id].filter(Boolean).join(':') || '-';
    },

    previewAllowedToolsText(job = this.jobDetail) {
      const tools = this.jobPreview(job)?.allowedTools || [];
      return tools.length ? tools.join(', ') : '-';
    },

    previewPromptText(job = this.jobDetail) {
      const preview = this.jobPreview(job);
      if (preview?.promptPreview) return preview.promptPreview;
      if (preview?.workflow?.steps?.length) return 'Workflow preview stores prompt diagnostics per step.';
      return 'No assembled prompt in this preview.';
    },

    previewStepStatusClass(step) {
      return step?.ok ? 'border-emerald-900/70 text-emerald-300 bg-emerald-950/30' : 'border-red-900/70 text-red-300 bg-red-950/30';
    },

    promptPreviewText() {
      const preview = this.jobPreview();
      if (preview?.promptPreview) return preview.promptPreview;
      if (this.jobDebug?.promptPreview) return this.jobDebug.promptPreview;
      if (this.jobDebug?.promptError) return `Prompt assembly failed: ${this.jobDebug.promptError}`;
      if (this.jobDebugLoading) return 'Loading prompt diagnostics...';
      return 'No prompt preview for this job.';
    },

    debuggerJson() {
      if (!this.jobDetail) return '{}';
      return JSON.stringify({
        job: this.jobDetail,
        preview: this.jobPreview(),
        debug: this.jobDebug,
        childJobs: this.jobDetailChildJobs,
        approvals: this.jobDetailApprovals,
      }, null, 2);
    },

    workflowStepRows(job = this.jobDetail) {
      if (!job) return [];
      const rawResultSteps = job.result?.stepResults || [];
      if (rawResultSteps.length) {
        const totalByStep = rawResultSteps.reduce((counts, step) => {
          counts[step.step] = (counts[step.step] || 0) + 1;
          return counts;
        }, {});
        const seenByStep = {};
        return rawResultSteps.map((step, index) => {
          const next = rawResultSteps[index + 1];
          seenByStep[step.step] = (seenByStep[step.step] || 0) + 1;
          const failed = this.workflowStepFailed(step.status);
          const badges = [];
          if (step.attempt && step.maxAttempts && step.maxAttempts > 1) {
            badges.push({ label: `attempt ${step.attempt}/${step.maxAttempts}`, type: 'info' });
          }
          if (step.visit && step.visit > 1) {
            badges.push({ label: `visit ${step.visit}`, type: 'info' });
          }
          if (totalByStep[step.step] > 1) {
            badges.push({ label: `pass ${seenByStep[step.step]}/${totalByStep[step.step]}`, type: 'muted' });
          }
          const handledFailure = failed && Boolean(next);
          if (handledFailure) badges.push({ label: 'handled', type: 'warn' });

          let jumpHint = '';
          if (failed && next) {
            if (next.step === step.step) jumpHint = `retry -> step ${next.step}`;
            else if (next.step === step.step + 1) jumpHint = `continued -> step ${next.step}`;
            else jumpHint = `failure -> step ${next.step}`;
          }

          const skipReason = step.status === 'skipped' && step.textOutput ? step.textOutput : '';
          return {
            ...step,
            source: 'result',
            sequence: index + 1,
            title: step.label || this.workflowStepTypeLabel(step.type),
            subtitle: this.workflowStepSubtitle(step),
            progressStatus: step.status,
            badges,
            handledFailure,
            jumpHint,
            skipReason,
          };
        });
      }

      const approvalStepIndexes = new Set(
        this.jobDetailApprovals
          .map(approval => Number(approval.stepIndex))
          .filter(stepIndex => Number.isFinite(stepIndex) && stepIndex > 0),
      );
      let nextChildStep = 1;
      const childRows = [...this.jobDetailChildJobs]
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
        .map(child => {
          while (approvalStepIndexes.has(nextChildStep)) nextChildStep += 1;
          const step = nextChildStep;
          nextChildStep += 1;
          return {
            step,
            sequence: step,
            type: child.workflow ? 'workflow' : child.agent ? 'agent' : child.prompt ? 'skill' : 'job',
            title: this.jobTitle(child),
            subtitle: child.trigger || child.id,
            status: child.status,
            progressStatus: child.status,
            childJobId: child.id,
            startedAt: child.startedAt || child.createdAt,
            completedAt: child.completedAt,
            durationMs: child.result?.durationMs,
            totalCostUsd: child.result?.totalCostUsd,
            totalTokens: child.result?.totalTokens,
            toolCallCount: child.result?.toolCallCount,
            error: child.result?.error,
            source: 'child',
          };
        });

      const rowsByStep = new Map(childRows.map(row => [row.step, row]));
      for (const approval of this.jobDetailApprovals) {
        const row = {
          step: approval.stepIndex,
          sequence: approval.stepIndex,
          type: 'approval',
          title: approval.prompt || 'Approval',
          subtitle: approval.resolvedAt ? `Resolved ${this.formatDate(approval.resolvedAt)}` : 'Waiting for approval',
          status: approval.status,
          progressStatus: approval.status,
          approvalId: approval.id,
          startedAt: approval.createdAt,
          completedAt: approval.resolvedAt,
          source: 'approval',
        };
        rowsByStep.set(approval.stepIndex, row);
      }

      return Array.from(rowsByStep.values()).sort((a, b) => a.step - b.step);
    },

    workflowStepTypeLabel(type) {
      return {
        agent: 'Agent',
        skill: 'Skill',
        workflow: 'Workflow',
        approval: 'Approval',
        job: 'Job',
      }[type] || 'Step';
    },

    workflowStepSubtitle(step) {
      const parts = [];
      if (step.childJobId) parts.push(step.childJobId.slice(0, 8));
      if (step.approvalId) parts.push(`approval ${step.approvalId.slice(0, 8)}`);
      if (step.sequence && step.sequence !== step.step) parts.push(`run ${step.sequence}`);
      if (step.startedAt) parts.push(this.formatDate(step.startedAt));
      return parts.join(' · ') || this.workflowStepTypeLabel(step.type);
    },

    workflowProgressPercent(job = this.jobDetail) {
      if (!job) return 0;
      const rows = this.workflowStepRows(job);
      if (job.status === 'done') return 100;
      if (job.status === 'failed') return rows.length ? Math.max(8, Math.round((this.workflowSettledStepCount(rows) / rows.length) * 100)) : 100;
      if (!rows.length) return job.status === 'running' ? 8 : 0;
      return Math.max(8, Math.round((this.workflowSettledStepCount(rows) / rows.length) * 100));
    },

    workflowSettledStepCount(rows = this.workflowStepRows()) {
      return rows.filter(step => ['done', 'failed', 'skipped', 'approved', 'denied', 'timed_out'].includes(step.progressStatus || step.status)).length;
    },

    workflowRunningStepId(rows = this.workflowStepRows()) {
      const running = rows.find(step => ['running', 'pending'].includes(step.progressStatus || step.status));
      return running ? running.step : null;
    },

    workflowStepVisualClass(status) {
      if (['done', 'approved'].includes(status)) return 'workflow-step--done';
      if (['failed', 'denied'].includes(status)) return 'workflow-step--failed';
      if (status === 'timed_out') return 'workflow-step--warning';
      if (status === 'skipped') return 'workflow-step--skipped';
      if (status === 'running') return 'workflow-step--running';
      return 'workflow-step--pending';
    },

    workflowStepFailed(status) {
      return ['failed', 'denied', 'timed_out'].includes(status);
    },

    workflowStepBadgeClass(type) {
      return {
        info: 'workflow-step__badge workflow-step__badge--info',
        warn: 'workflow-step__badge workflow-step__badge--warn',
        muted: 'workflow-step__badge workflow-step__badge--muted',
      }[type] || 'workflow-step__badge workflow-step__badge--muted';
    },

    workflowStepMetricText(step) {
      const metrics = [];
      if (step.totalCostUsd) metrics.push(this.formatUsd(step.totalCostUsd));
      if (step.durationMs) metrics.push(this.formatDuration(step.durationMs));
      if (step.totalTokens) metrics.push(`${this.formatNumber(step.totalTokens)} tokens`);
      if (step.toolCallCount) metrics.push(`${this.formatNumber(step.toolCallCount)} tools`);
      return metrics.join(' · ');
    },

    async copyJobId(job = this.jobDetail) {
      if (!job?.id) return;
      try {
        await navigator.clipboard.writeText(job.id);
        this.notify('Copied job id');
      } catch {
        this.notify('Could not copy job id', 'error');
      }
    },

    openJobCardFile(filePath) {
      if (!filePath) return;
      this.navigate('files');
      this.$nextTick(async () => {
        await this.loadFileRoots();
        this.fileRoot = 'vault';
        const normalized = String(filePath).replace(/^.*\/admin\/?/, '');
        const parent = normalized.split('/').slice(0, -1).join('/');
        await this.loadFiles(parent);
        const entry = this.fileEntries.find(item => item.path === normalized);
        if (entry) this.openFileEntry(entry);
      });
    },
  },
};
