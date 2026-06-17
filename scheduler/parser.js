'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const JOBS_FILE = path.join(__dirname, 'jobs.json');
const CLAUDE_PATH = process.env.CLAUDE_PATH || `${process.env.HOME}/.local/bin/claude`;
const TIMEZONE = 'America/Los_Angeles';

const CLASSIFICATION_PROMPT = (text, nowLocal, nowISO) => `You are a scheduling assistant. The current date and time is ${nowLocal} (${nowISO} UTC).

Analyze this message and determine if it is a scheduling or reminder request.

Message: ${JSON.stringify(text)}

If this IS a scheduling/reminder request, respond with ONLY a raw JSON object (no markdown, no explanation).

For a ONE-TIME reminder (e.g. "in 2 minutes", "at 3pm today", "tomorrow morning", "remind me to X"):
{
  "intent": "schedule",
  "scheduleType": "once",
  "prompt": "<concise reminder text — what to remind the user about>",
  "runAt": "<ISO 8601 UTC timestamp for exactly when to send the reminder>"
}

For a RECURRING task (e.g. "every day at 9am", "every Monday", "daily", "weekly"):
{
  "intent": "schedule",
  "scheduleType": "recurring",
  "prompt": "<the task instruction to run>",
  "cron": "<valid 5-field cron expression in the user's local timezone>"
}

If this is NOT a scheduling/reminder request:
{"intent":"other"}

Cron expression guide (local time):
  Daily at 9am:     0 9 * * *
  Every Monday 8am: 0 8 * * 1
  Weekdays at 10am: 0 10 * * 1-5
  Every hour:       0 * * * *
  Every Sunday 6pm: 0 18 * * 0

Output ONLY the JSON object. No other text.`;

async function callClaude(promptText) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_PATH, ['--print'], {
      env: { ...process.env },
    });

    child.stdin.write(promptText);
    child.stdin.end();

    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', () => {
      try {
        const match = stdout.match(/\{[\s\S]*\}/);
        if (match) {
          resolve(JSON.parse(match[0]));
        } else {
          resolve({ intent: 'other' });
        }
      } catch {
        resolve({ intent: 'other' });
      }
    });
    child.on('error', () => resolve({ intent: 'other' }));

    setTimeout(() => {
      child.kill();
      resolve({ intent: 'other' });
    }, 60 * 1000);
  });
}

function readJobs() {
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeJob(job) {
  const jobs = readJobs();
  jobs.push(job);
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
  return job;
}

/**
 * Classify a Slack message and, if it's a scheduling/reminder request, persist the job.
 *
 * @param {string} text         - Raw message text from Slack
 * @param {string} slackChannel - Channel ID to post results to
 * @param {string} [workingDir] - Working directory for recurring tasks
 * @returns {Promise<object|null>} The saved job object, or null if not a scheduling request
 */
async function parseAndSave(text, slackChannel, workingDir, userId) {
  const now = new Date();
  const nowLocal = now.toLocaleString('en-US', { timeZone: TIMEZONE, dateStyle: 'full', timeStyle: 'long' });
  const nowISO = now.toISOString();

  const result = await callClaude(CLASSIFICATION_PROMPT(text, nowLocal, nowISO));

  if (result.intent !== 'schedule') {
    return null;
  }

  let job;

  if (result.scheduleType === 'once') {
    if (!result.runAt) return null;
    job = {
      id: randomUUID(),
      scheduleType: 'once',
      runAt: result.runAt,
      prompt: result.prompt,
      runOnce: true,
      workingDir: null,
      slackUserId: userId || null,
      slackChannel,
      createdAt: nowISO,
      lastRun: null,
      enabled: true,
    };
  } else {
    // recurring
    if (!result.cron) return null;
    job = {
      id: randomUUID(),
      scheduleType: 'recurring',
      cron: result.cron,
      prompt: result.prompt,
      runOnce: false,
      workingDir: workingDir || `${process.env.HOME}/claude-workspaces`,
      slackUserId: userId || null,
      slackChannel,
      createdAt: nowISO,
      lastRun: null,
      enabled: true,
    };
  }

  writeJob(job);
  return job;
}

module.exports = { parseAndSave };

// CLI usage: node parser.js "<text>" "<channel>" [workingDir] [userId]
if (require.main === module) {
  const [, , text, channel, workingDir, userId] = process.argv;
  if (!text) {
    console.error('Usage: node parser.js "<text>" "<channel>" [workingDir]');
    process.exit(1);
  }
  parseAndSave(text, channel || 'general', workingDir, userId)
    .then((job) => {
      console.log(JSON.stringify(job, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
