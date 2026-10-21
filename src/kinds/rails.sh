echo "▶ Ruby project"
need ruby; need bundle
[ -f Gemfile ] || { echo "✗ not a Rails/Rack app (no Gemfile) — run a script with: ruby file.rb"; exit 1; }
bundle config set --local path "$HOME/bundle" >/dev/null
echo "▶ bundle install… (first run, can take a few minutes)"
bundle install --jobs 4 || { echo "✗ bundle install failed"; exit 1; }
if [ -f bin/rails ]; then
  export RAILS_ENV=development RAILS_LOG_TO_STDOUT=1
  echo "▶ rails db:prepare"; bin/rails db:prepare || echo "⚠ db:prepare failed — fix it and run: bin/rails db:prepare"
  rm -f tmp/pids/server.pid
  echo "▶ Rails is starting on port 3000"; exec bin/rails server -b 0.0.0.0 -p 3000
elif [ -f config.ru ]; then
  echo "▶ rackup on port 9292"; exec bundle exec rackup -o 0.0.0.0 -p 9292
else
  echo "✗ not a Rails/Rack app (no bin/rails or config.ru) — run a script with: bundle exec ruby file.rb"; exit 1
fi
