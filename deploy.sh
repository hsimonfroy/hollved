#!/bin/sh
rm -rf build
npm run build
cd ./build
git init
git checkout -b main
git add .
git commit -m 'push to gh-pages'
git push --force https://github.com/hsimonfroy/hollved.git main:gh-pages
cd ../
git tag `date "+release-%Y%m%d%H%M%S"`
git push --tags

# TO DEPLOY LOCALLY
# cd hollved-data
# http-server --cors -p 9090

# cd hollved
# npm i
# npm start
