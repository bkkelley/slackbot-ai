window.AppModules = window.AppModules || {};

window.AppModules.channels = {
  state() {
    return {
      channels: [],
      channelsLoading: false,
      channelsSaving: false,
      channelsError: '',
      newChannel: { platform: 'slack', channelId: '', agent: '' },
    };
  },

  methods: {
    async loadChannels() {
      this.channelsLoading = true;
      this.channelsError = '';
      try {
        const data = await this.apiJson('api/channels', {}, 'Channels load failed');
        this.channels = data.map(item => ({ ...item, _saving: false, _error: '' }))
          .sort((a, b) => a.platform.localeCompare(b.platform) || a.channelId.localeCompare(b.channelId));
      } catch (err) {
        this.channels = [];
        this.channelsError = err.message;
      } finally {
        this.channelsLoading = false;
      }
    },

    async saveChannelMapping(mapping) {
      mapping._saving = true;
      mapping._error = '';
      try {
        await this.apiJson(
          `api/channels/${encodeURIComponent(mapping.platform)}/${encodeURIComponent(mapping.channelId)}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: mapping.agent }),
          },
          'Channel save failed'
        );
        this.notify('Channel mapping saved');
        await this.loadChannels();
      } catch (err) {
        mapping._error = err.message;
        throw err;
      } finally {
        mapping._saving = false;
      }
    },

    async createChannelMapping() {
      this.channelsError = '';
      const mapping = {
        platform: this.newChannel.platform,
        channelId: String(this.newChannel.channelId || '').trim(),
        agent: this.newChannel.agent,
      };
      if (!mapping.platform || !mapping.channelId || !mapping.agent) {
        this.channelsError = 'Platform, channel ID, and agent are required.';
        return;
      }
      this.channelsSaving = true;
      try {
        await this.saveChannelMapping({ ...mapping, _saving: false, _error: '' });
        this.newChannel = { platform: 'slack', channelId: '', agent: '' };
      } finally {
        this.channelsSaving = false;
      }
    },

    confirmDeleteChannel(mapping) {
      this.confirmDelete = {
        show: true,
        name: `${mapping.platform}:${mapping.channelId}`,
        action: async () => {
          await this.apiJson(
            `api/channels/${encodeURIComponent(mapping.platform)}/${encodeURIComponent(mapping.channelId)}`,
            { method: 'DELETE' },
            'Channel delete failed'
          );
          this.confirmDelete.show = false;
          this.notify('Channel mapping deleted');
          await this.loadChannels();
        },
      };
    },

    channelAgentOptions() {
      return this.agents
        .filter(agent => !agent.scope)
        .map(agent => agent.name)
        .sort((a, b) => a.localeCompare(b));
    },

    channelPlatformClass(platform) {
      return platform === 'discord'
        ? 'bg-violet-950/50 text-violet-300 border-violet-900'
        : 'bg-emerald-950/50 text-emerald-300 border-emerald-900';
    },
  },
};
