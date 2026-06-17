window.AppModules = window.AppModules || {};

window.AppModules.approvals = {
  state() {
    return {
      approvals: [],
      approvalsLoading: false,
      approvalsError: '',
      approvalsTimer: null,
      approvalFilter: 'pending',
      approvalComments: {},
    };
  },

  methods: {
    startApprovalsRefresh() {
      this.loadApprovals();
      this.stopApprovalsRefresh();
      this.approvalsTimer = setInterval(() => this.loadApprovals(), 8000);
    },

    stopApprovalsRefresh() {
      if (this.approvalsTimer) {
        clearInterval(this.approvalsTimer);
        this.approvalsTimer = null;
      }
    },

    async loadApprovals() {
      this.approvalsLoading = true;
      this.approvalsError = '';
      try {
        const qs = new URLSearchParams();
        if (this.approvalFilter !== 'all') qs.set('status', this.approvalFilter);
        qs.set('limit', '80');
        const data = await this.apiJson(`api/approvals?${qs}`, {}, 'Approvals load failed');
        this.approvals = data.approvals || [];
      } catch (err) {
        this.approvalsError = err.message;
      } finally {
        this.approvalsLoading = false;
      }
    },

    async resolveApproval(approval, decision) {
      const action = decision === 'approved' ? 'approve' : 'deny';
      try {
        await this.apiJson(`api/approvals/${encodeURIComponent(approval.id)}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            resolvedBy: 'management-ui',
            comment: this.approvalComments[approval.id] || undefined,
          }),
        }, `Approval ${action} failed`);
        delete this.approvalComments[approval.id];
        this.notify(decision === 'approved' ? 'Approval granted' : 'Approval denied');
        await this.loadApprovals();
        if (this.tab === 'jobs') await this.loadQueue();
      } catch {
        // apiJson already reports the error.
      }
    },

    approvalStatusClass(status) {
      if (status === 'approved') return 'text-green-400 border-green-900 bg-green-950/30';
      if (status === 'done') return 'text-green-400 border-green-900 bg-green-950/30';
      if (status === 'denied') return 'text-red-400 border-red-900 bg-red-950/30';
      if (status === 'failed') return 'text-red-400 border-red-900 bg-red-950/30';
      if (status === 'timed_out') return 'text-yellow-400 border-yellow-900 bg-yellow-950/30';
      if (status === 'skipped') return 'text-gray-400 border-gray-800 bg-gray-950';
      return 'text-indigo-300 border-indigo-900 bg-indigo-950/30';
    },
  },
};
