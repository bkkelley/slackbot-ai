const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

module.exports = {
  vaultPath: process.env.VAULT_PATH || `${process.env.HOME}/claude-workspaces/global`,
  claudePath: process.env.CLAUDE_PATH || `${process.env.HOME}/.local/bin/claude`,
  baseDirectory: process.env.BASE_DIRECTORY || `${process.env.HOME}/claude-workspaces`,
  schedulerDir: path.join(__dirname, '../scheduler'),
  agentWorkspacesDir: process.env.BASE_DIRECTORY || `${process.env.HOME}/claude-workspaces`,
};
