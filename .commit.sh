#!/bin/bash
cd /Users/chikochingaya/.pi/agent/git/github.com/nicobailon/pi-messenger
git add -A
git commit -m "fix: namespace always written to task JSON, getTasks uses namespace in work/review/revise/sync handlers"
rm -f .build-check.sh .commit.sh
