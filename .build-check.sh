#!/bin/bash
cd /Users/chikochingaya/.pi/agent/git/github.com/nicobailon/pi-messenger
echo "=== BUILD ===" 
npm run build 2>&1
echo "=== TEST ===" 
npm test 2>&1
