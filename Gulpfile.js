'use strict'

const fs = require('fs')
const path = require('path')
const gulp = require('gulp')
const mocha = require('gulp-mocha')
//const istanbul = require('gulp-istanbul')
const spawn = require('child_process').spawn


// Describe basic tasks and their associated files
const tasks = {
  unit: {
    lib: 'lib/*.js',
    test: 'test/*.test.js',
    bench: 'test/*.bench.js',
  },
  probes: {
    lib: 'lib/probes/*.js',
    test: 'test/probes/*.test.js',
    bench: 'test/probes/*.bench.js',
  },
  composite: {
    test: 'test/composite/*.test.js'
  }
}

// group the tasks.
const taskGroups = {}
Object.keys(tasks).forEach(k => {
  taskGroups[k] = []
})

// Make individual unit test tasks
const unitTests = fs.readdirSync('test/')

unitTests.forEach(function (file) {
  if (!/.+\.test\.js$/.test(file)) return

  const name = file.replace(/^(.+)\.[^\.]+\.js/, '$1')
  // add the task to the dictionary.
  tasks['unit:' + name] = {
    lib: 'lib/*.js',
    test: 'test/' + file,
    bench: 'test/' + name + '.bench.js'
  }
  taskGroups.unit.push('unit:' + name)
})

// some probes run a different named test. this is important
// because testeachversion needs to change a package; it doesn't
// handle changing two packages in a synchronized fashion. E.g.,
// the levelup probe is tested using the level package. The testing
// program, testeachversion, doesn't know that it needs a specific
// versions of leveldown for each version of levelup.
const nameMap = {
  levelup: 'level'
}

// Describe probe tasks automatically
const probes = fs.readdirSync('lib/probes')

probes.forEach(function (probe) {
  let name = probe.replace(/\.js$/, '')

  if (name in nameMap) {
    name = nameMap[name]
  }
  const task = tasks['probe:' + name] = {
    lib: 'lib/probes/' + probe
  }

  const test = 'test/probes/' + name + '.test.js'
  if (fs.existsSync(test)) {
    task.test = test
    taskGroups.probes.push('probe:' + name)
  }

  const bench = 'test/probes/' + name + '.bench.js'
  if (fs.existsSync(bench)) {
    task.bench = bench
  }

})

// make composite test tasks entries
const compositeTests = fs.readdirSync('test/composite')
compositeTests.forEach(function (file) {
  if (!/.+\.test\.js$/.test(file)) return

  // get only the name before .(test|bench).js
  const name = file.replace(/^(.+)\.[^\.]+\.js/, '$1')
  tasks['composite:' + name] = {
    test: 'test/composite/' + name + '.test.js'
  }

  taskGroups.composite.push('composite:' + name)
})

// make unit. probes, composite tests
Object.keys(tasks).forEach(function (name) {
  const task = tasks[name]
  // make individual tests (unit:error, etc.) within each.
  if (task.test) {
    makeTestTask('test:' + name, task.test)
  }
})

// Create coverage tasks
//makeCoverageTask('coverage', 'test/**/*.test.js')
//Object.keys(tasks).forEach(function (name) {
//  const task = tasks[name]
//  if (task.test) {
//    makeCoverageTask('coverage:' + name, task.test, task.lib)
//  }
//})

/*
// Create watcher task
gulp.task('watch', function () {
  Object.keys(tasks).forEach(function (name) {
    if (name === 'probes') return
    const task = tasks[name]

    const shouldBench = task.bench && !process.env.SKIP_BENCH

    // These spawns tasks in a child processes. This is useful for
    // preventing state persistence between runs in a watcher and
    // for preventing crashes or exits from ending the watcher.
    function coverage () {
      return spawn('gulp', ['coverage:' + name], {
        stdio: 'inherit'
      })
    }

    function bench () {
      return spawn('gulp', ['bench:' + name], {
        stdio: 'inherit'
      })
    }

    function sequence (steps) {
      function next () {
        const step = steps.shift()
        const v = step()
        if (steps.length) {
          v.on('close', next)
        }
        return v
      }
      return next()
    }

    gulp.watch([ task.lib ], function () {
      const steps = []
      if (task.test) steps.push(coverage)
      if (shouldBench) steps.push(bench)
      return sequence(steps)
    })

    if (task.test) {
      gulp.watch([ task.test ], coverage)
    }

    if (shouldBench) {
      gulp.watch([ task.bench ], bench)
    }
  })
})
// */

//
// Helpers
//

function tester () {
  require('./')
  require('should')

  return mocha({
    reporter: 'spec',
    timeout: 5000
  }).once('error', function (e) {
    console.error(e.stack)
    process.exit(1)
  })
}

/*
function makeBuildTask (name, files) {
  const p = files.replace(/^dist/, 'lib')
  let d = files.slice(0, files.length - path.basename(files).length - 1)
  if (d === 'dist/**') d = 'dist'
  gulp.task(name, ['dist/probes'], function () {
    return gulp.src(p)
      .pipe(gulp.dest(d))
  })
}
// */

gulp.task('unit', gulp.series(taskGroups.unit.map(name => 'test:' + name)))
gulp.task('probes', gulp.series(taskGroups.probes.map(name => 'test:' + name)))

function makeTestTask (name, files) {
  gulp.task(name, function (done) {
    return gulp.src(files, {
      read: false
    })
      .pipe(tester())
      .once('end', done)
  })
}


//function makeCoverageTask (name, files, libs) {
//  libs = libs || 'dist/**/*.js'
//
//  gulp.task('pre-' + name, ['build'], function () {
//    return gulp.src(libs)
//      .pipe(istanbul())
//      .pipe(istanbul.hookRequire())
//  })
//
//  gulp.task(name, ['pre-' + name], function () {
//    return gulp.src(files)
//      .pipe(tester())
//      .pipe(istanbul.writeReports({
//        dir: './coverage/' + name
//      }))
//      .pipe(istanbul.enforceThresholds({
//        // TODO: 70% is kind of...bad.
//        thresholds: {global: 70}
//      }))
//      .once('end', process.exit)
//  })
//}

