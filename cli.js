#!/usr/bin/env node

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const meow = require("meow");
const execa = require("execa");
const dedent = require("dedent");
const inquirer = require("inquirer");

// Global variables

const configDir = path.join(os.homedir(), "/.config/");
const configPath = path.join(configDir, "sshfs-box.json");

// CLI

const cli = meow(
  `
  Small CLI tool to simply mount/unmount remote sshfs directories

  Usage
    $ sshfs-box

  Options
    --config, -c  Configure remote & local paths to connect
                  Config stored in ~/.config/sshfs-box.json
`,
  {
    alias: {
      c: "config",
      configure: "config"
    }
  }
);

// Main

let configString;
try {
  configString = fs.readFileSync(configPath, "utf8");
} catch (e) {}

if (cli.flags.config) {
  promptEditConfig(configString).then(promptSshfs);
} else {
  if (configString) {
    const validation = validateConfigString(configString); // true ok, otherwise returns error string
    if (validation === true) {
      promptSshfs(JSON.parse(configString));
    } else {
      process.stderr.write(
        `${configPath} does not contain valid config, please fix it`
      );
      promptEditConfig(configString).then(promptSshfs);
    }
  } else {
    process.stderr.write(
      `Cant open config on ${configPath}, creating new config`
    );
    promptEditConfig().then(promptSshfs);
  }
}

// Prompt functions

function promptEditConfig(defaultConfigOverride) {
  const defaultConfig = dedent`
    {
      "urls": [
        "user@host1:dir",
        "user@host2:dir"
      ],
      "folder": "${path.join(os.homedir(), "/remote")}"
    }
  `;

  const promptSettings = {
    type: "editor",
    name: "config",
    message: "Configure sshfs-box",
    default: defaultConfigOverride || defaultConfig,
    validate: validateConfigString
  };

  return inquirer.prompt(promptSettings).then(response => {
    const configString = response.config;
    const config = JSON.parse(configString);
    try {
      fs.mkdirSync(configDir);
    } catch (e) {
      // pass
    }

    fs.writeFileSync(configPath, configString, "utf8");

    return config;
  });
}

function promptSshfs(config) {
  const mounted = execa.shellSync("mount").stdout.split("\n");

  function isMounted(remote, local) {
    return mounted.some(mount => mount.startsWith(remote + " on " + local));
  }

  const data = config.urls.map(remote => {
    // user@host:/dir/dir => user@host--dir-div
    const local = path.join(
      config.folder,
      remote.replace(/:/g, "-").replace(/\//g, "-")
    );

    const isChecked = isMounted(remote, local);

    return {
      name: `${remote} ↔ ${local}`,
      checked: isChecked,
      remote: remote,
      local: local
    };
  });

  inquirer
    .prompt({
      type: "checkbox",
      message: "SSHFS mount/unmount dirs",
      name: "urls",
      choices: data
    })
    .then(answers => {
      // mount selected items that are not already mounted
      answers.urls
        .map(url => data.find(item => item.name === url))
        .filter(item => !isMounted(item.remote, item.local))
        .forEach(data => {
          execa.sync("mkdir", ["-p", data.local]);
          const { stderr } = execa.sync("sshfs", [data.remote, data.local]);
          if (stderr) {
            process.stderr.write(stderr);
            process.exit(1);
          }
          process.stdout.write(`[x] mounted   ${data.remote}`);
        });

      // unmount items that have been unselected
      data
        .filter(item => answers.urls.includes(item.name) === false)
        .filter(item => isMounted(item.remote, item.local))
        .forEach(data => {
          const res = execa.sync("fusermount", ["-u", data.local]);
          if (res.stderr) {
            process.stderr.write(res.stderr);
            process.exit(1);
          }
          execa.sync("rm", ["-r", data.local]);
          process.stdout.write(`[ ] unmounted ${data.remote}`);
        });
    });
}

function validateConfigString(configString) {
  let config;
  try {
    config = JSON.parse(configString);
  } catch (e) {
    return "Error parsing JSON";
  }

  if (!config.urls) return `"urls" field is missing or empty`;
  if (!Array.isArray(config.urls)) return `"urls" filed is not an array`;
  if (config.urls.some(item => typeof item !== "string"))
    return `all fields in "urls" filed need to be string`;
  if (!config.folder) return `"folder" field is missing or empy`;
  if (typeof config.folder !== "string") return `"folder" field must be string`;

  return true;
}
