# Switchboard's zsh init fragment.
#
# Sourced via ZDOTDIR override by `pty-manager.ts` when spawning an
# interactive zsh. Runs the user's real ~/.zshrc first so their aliases,
# themes, $PATH etc. still apply, then sets keybindings that the
# Switchboard terminal sends from the GUI (Cmd/Option + arrows/backspace).
#
# Doing it here — instead of asking every user to paste lines into their
# own .zshrc — is what makes fresh installs "just work."

# 0. User's login-shell config (.zshenv + .zprofile).
#    Setting ZDOTDIR (we do, to inject keybindings below) redirects *all*
#    of zsh's per-user startup files away from $HOME — so the
#    `~/.zprofile` that Apple Silicon Homebrew installs (the line
#    `eval "$(/opt/homebrew/bin/brew shellenv)"`) never runs and PATH
#    stays at /usr/bin:/bin only. That breaks `carapace`, `starship`,
#    `nvm`, anything the user's .zshrc references from /opt/homebrew or
#    ~/.cargo. Source the real files manually before .zshrc so PATH is
#    populated before the user config runs.
[ -f "$HOME/.zshenv" ]   && source "$HOME/.zshenv"
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"

# 1. User's real shell config
if [ -f "$HOME/.zshrc" ]; then
  source "$HOME/.zshrc"
fi

# 2. Make word motions behave like bash (treat punctuation as separators).
#    Without this, `foo-bar` is one word and Option+Backspace kills the
#    whole thing.
autoload -U select-word-style
select-word-style bash

# 3. Keybindings that map the escape sequences Switchboard sends:
#    - Option+Backspace  → backward-kill-word
#    - Option+Left/Right → backward-word / forward-word
#    - Cmd+Left/Right    → beginning-of-line / end-of-line (we send ESC O H/F)
#    - Cmd+Backspace     → kill-whole-line (Ctrl+U already bound)
bindkey -e                          # emacs-style line editing (macOS default)
bindkey '\e^?' backward-kill-word   # Option+Backspace
bindkey '^[b'  backward-word        # legacy Option+Left
bindkey '^[f'  forward-word         # legacy Option+Right
bindkey '^[[1;3D' backward-word     # Option+Left (modern xterm)
bindkey '^[[1;3C' forward-word      # Option+Right
bindkey '\eOH' beginning-of-line    # Cmd+Left
bindkey '\eOF' end-of-line          # Cmd+Right
bindkey '^U'   kill-whole-line      # Cmd+Backspace (we send Ctrl+U)

# 4. Marker so users can confirm the override is active: `echo $SWITCHBOARD_SHELL`
export SWITCHBOARD_SHELL=1
