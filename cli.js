#!/usr/bin/env node

"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const meow = require("meow");
const chalk = require("chalk");
const execa = require("execa");
const inquirer = require("inquirer");

// Global variables

const configDir = path.join(os.homedir(), "/.config/");
const configPath = path.join(configDir, "sshfs-box.json");

// CLI

const cli = meow(
  `
  Small CLI tool to mount/unmount directories on remote servers with sshfs.

  Usage
    $ sshfs-box

  Options
    --config, -c  Configure remote & local paths
                  Config stored in ~/.config/sshfs-box.json
`,
  {
    alias: {
      c: "config",
      configure: "config",
      settings: "config",
    },
  }
);

// Main

async function main() {
  let configString;
  try {
    configString = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    process.stdout.write(
      `Can't open config on ${configPath}, creating new config`
    );
    await promptEditConfig();
    await promptSshfs();
    return;
  }

  if (cli.flags.config) {
    promptEditConfig(configString).then(promptSshfs);
  } else {
    const [configValid] = validateConfigString(configString);
    if (configValid) {
      promptSshfs(JSON.parse(configString));
    } else {
      process.stdout.write(
        `${configPath} does not contain valid config, please fix it`
      );
      promptEditConfig(configString).then(promptSshfs);
    }
  }
}

main(); // Start the app.

// Prompt functions.

function promptEditConfig(defaultConfigOverride) {
  const defaultConfig = JSON.stringify(
    {
      urls: ["user@host1:", "user@host2:/home/user", "user@host2:/www"],
      folder: path.join(os.homedir(), "/remote"),
    },
    null,
    2
  );

  const promptSettings = {
    type: "editor",
    name: "config",
    message: "Configure sshfs-box",
    default: defaultConfigOverride || defaultConfig,
    validate: userInput => {
      const [valid, err] = validateConfigString(userInput);
      // Inquirer expects true if input is valid, otherwise string error message.
      return valid ? true : err;
    },
  };

  return inquirer.prompt(promptSettings).then(response => {
    const configString = response.config;
    const config = JSON.parse(configString);
    try {
      fs.mkdirSync(configDir);
    } catch (e) {
      // Pass.
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
      local: local,
    };
  });

  return inquirer
    .prompt({
      type: "checkbox",
      message: "SSHFS mount/unmount dirs",
      name: "urls",
      choices: data,
    })
    .then(answers => {
      // mount selected items that are not already mounted
      answers.urls
        .map(url => data.find(item => item.name === url))
        .filter(item => !isMounted(item.remote, item.local))
        .forEach(data => {
          execa.sync("mkdir", ["-p", data.local]);

          try {
            execa.sync("sshfs", [data.remote, data.local]);
          } catch (err) {
            process.stdout.write(`\n[ ] error   ${data.remote}`);
            process.stdout.write(`\n${err}`);
            return;
          }

          process.stdout.write(`\n[x] mounted   ${data.remote}`);
        });

      // unmount items that have been unselected
      data
        .filter(item => !answers.urls.includes(item.name))
        .filter(item => isMounted(item.remote, item.local))
        .forEach(data => {
          const res = execa.sync("fusermount", ["-u", data.local]);
          if (res.stderr) {
            process.stderr.write(res.stderr);
            process.exit(1);
          }
          execa.sync("rm", ["-r", data.local]);
          process.stdout.write(`\n[ ] unmounted ${data.remote}`);
        });
    });
}

function validateConfigString(configString) {
  let config;
  try {
    config = JSON.parse(configString);
  } catch (e) {
    return [false, "Error parsing JSON"];
  }

  if (!config.urls) {
    return [false, `"urls" field is missing or empty`];
  } else if (!Array.isArray(config.urls)) {
    return [false, `"urls" filed is not an array`];
  } else if (config.urls.some(item => typeof item !== "string")) {
    return [false, `all fields in "urls" filed need to be string`];
  } else if (!config.folder) {
    return [false, `"folder" field is missing or empy`];
  } else if (typeof config.folder !== "string") {
    return [false, `"folder" field must be string`];
  }

  return [true, null];
}
