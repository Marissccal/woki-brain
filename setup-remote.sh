#!/bin/bash
# Script to setup remote repository for woki-brain

echo "Setting up remote repository for woki-brain..."
echo ""
echo "Please create a new repository on GitHub/GitLab called 'woki-brain' first."
echo "Then run this script with the repository URL as argument."
echo ""
echo "Usage: ./setup-remote.sh <repository-url>"
echo "Example: ./setup-remote.sh https://github.com/Marissccal/woki-brain.git"
echo ""

if [ -z "$1" ]; then
    echo "Error: Repository URL is required"
    exit 1
fi

REPO_URL=$1

echo "Adding remote origin: $REPO_URL"
git remote add origin "$REPO_URL"

echo ""
echo "Pushing main branch to remote..."
git push -u origin main

echo ""
echo "Done! Repository is now connected to remote."
echo "You can verify with: git remote -v"

