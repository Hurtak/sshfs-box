#!/usr/bin/env node

'use strict'

const os = require('os')
const fs = require('fs')
const path = require('path')
const execa = require('execa')
const inquirer = require('inquirer')

const configPath = process.env.NODE_ENV === 'development'
  ? path.join(__dirname, 'test.json')
  : path.join(os.homedir(), '/.config/sshfs-box.json')

const config = fs.readFileSync(configPath, 'utf8')
const {urls, folder} = JSON.parse(config)

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

inquirer.prompt([
  {
    type: 'checkbox',
    message: 'SSHFS mount/unmount dirs',
    name: 'urls',
    choices: data
  }
]).then((answers) => {
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
