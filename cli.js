#!/usr/bin/env node

'use strict'

const os = require('os')
const fs = require('fs')
const path = require('path')
const meow = require('meow')
const execa = require('execa')
const inquirer = require('inquirer')

// Global variables

const configDir = path.join(os.homedir(), '/.config/')
const configPath = path.join(configDir, 'sshfs-box.json')

// CLI

const cli = meow(`
  Small CLI tool to simply mount/unmount remote sshfs directories

  Usage
    $ sshfs-box

  Options
    --config, -c  Configure remote & local paths to connect
                  Config stored in ~/.config/sshfs-box.json
`, {
  alias: {
    c: 'config',
    configure: 'config'
  }
})

// Main

let config
try {
  config = fs.readFileSync(configPath, 'utf8')
  config = JSON.parse(config)
} catch (e) {}

if (cli.flags.config) {
  promptEditConfig(config).then(promptSshfs)
} else {
  if (config) {
    promptSshfs(config)
  } else {
    console.error(`Cant open config on ${configPath}, creating new config`)
    promptEditConfig().then(promptSshfs)
  }
}

// Prompt functions

function promptEditConfig (defaultConfig) {
  const setConfig = {
    type: 'editor',
    name: 'settings',
    message: 'Configure sshfs-box',
    default: JSON.stringify(defaultConfig, null, 2) || [
      '{',
      '  "urls": [',
      '    "user@host1:dir",',
      '    "user@host2:dir"',
      '  ],',
      `  "folder": "${path.join(os.homedir(), '/remote')}"`,
      '}',
      ''
    ].join('\n'),
    validate: function (text) {
      let data
      try {
        data = JSON.parse(text)
      } catch (e) {
        return 'Error parsing JSON'
      }

      if (!data.urls) return `"urls" field is missing or empty`
      if (!Array.isArray(data.urls)) return `"urls" filed is not an array`
      if (data.urls.some(item => typeof item !== 'string')) return `all fields in "urls" filed need to be string`
      if (!data.folder) return `"folder" field is missing or empy`
      if (typeof data.folder !== 'string') return `"folder" field must be string`

      return true
    }
  }

  return inquirer.prompt(setConfig)
    .then(function (response) {
      const config = JSON.parse(response.settings)
      try {
        fs.mkdirSync(configDir)
      } catch (e) {}

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

      return config
    })
}

function promptSshfs (config) {
  const {urls, folder} = config

  const mounted = execa.shellSync('mount').stdout.split('\n')

  function isMounted (remote, local) {
    return mounted.some(mount => mount.startsWith(remote + ' on ' + local))
  }

  const data = urls.map(remote => {
    const local = path.join(folder, remote).replace(/[:].*?$/, '') // user@host:dir -> user@host
    const isChecked = isMounted(remote, local)

    return {
      name: `${remote} ↔ ${local}`,
      checked: isChecked,
      remote: remote,
      local: local
    }
  })

  inquirer.prompt({
    type: 'checkbox',
    message: 'SSHFS mount/unmount dirs',
    name: 'urls',
    choices: data
  })
  .then((answers) => {
    // mount selected items that are not already mounted
    answers.urls
      .map(url => data.find(item => item.name === url))
      .filter(item => !isMounted(item.remote, item.local))
      .forEach(data => {
        execa.sync('mkdir', ['-p', data.local])
        const {stderr} = execa.sync('sshfs', [data.remote, data.local])
        if (stderr) {
          console.error(stderr)
          process.exit(1)
        }
        console.log(`[x] mounted   ${data.remote}`)
      })

    // unmount items that have been unselected
    data
      .filter(item => answers.urls.includes(item.name) === false)
      .filter(item => isMounted(item.remote, item.local))
      .forEach(data => {
        const res = execa.sync('fusermount', ['-u', data.local])
        if (res.stderr) {
          console.error(res.stderr)
          process.exit(1)
        }
        execa.sync('rm', ['-r', data.local])
        console.log(`[ ] unmounted ${data.remote}`)
      })
  })
}
