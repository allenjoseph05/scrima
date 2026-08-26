import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useCoachStore } from '../../stores/coachStore';

// ── Greeting with typewriter effect ─────────────────────────────────────────

function GreetingMessage({ text }: { text: string }) {
  const [displayed, setDisplayed] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(interval);
        setDone(true);
      }
    }, 25);
    return () => clearInterval(interval);
  }, [text]);

  return (
    <div className="text-center px-8 py-12 max-w-lg mx-auto">
      <div className="flex items-center justify-center gap-2 mb-4">
        <div
          className="w-2 h-2 rounded-full"
          style={{
            background: '#7C3AED',
            boxShadow: '0 0 8px #7C3AED60',
            animation: 'glow-pulse 2s ease-in-out infinite',
          }}
        />
        <span
          className="text-[10px] font-mono tracking-[0.2em] uppercase"
          style={{ color: '#7C3AED' }}
        >
          SCRIMA COACH
        </span>
        <div
          className="w-2 h-2 rounded-full"
          style={{
            background: '#7C3AED',
            boxShadow: '0 0 8px #7C3AED60',
            animation: 'glow-pulse 2s ease-in-out infinite',
          }}
        />
      </div>
      <p className="text-base leading-relaxed" style={{ color: '#E8EFFF' }}>
        {displayed}
        {!done && (
          <span
            className="inline-block w-[2px] h-[1em] ml-0.5 align-middle"
            style={{
              background: '#00D4FF',
              animation: 'typewriter-cursor 0.8s step-end infinite',
            }}
          />
        )}
      </p>
    </div>
  );
}

// ── Suggested chips ─────────────────────────────────────────────────────────

const SUGGESTIONS = ['What should I focus on?', 'What drills should I do?', 'How am I improving?'];

function SuggestionChips({ onSelect }: { onSelect: (text: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2 justify-center py-3">
      {SUGGESTIONS.map((s) => (
        <button
          key={s}
          onClick={() => onSelect(s)}
          className="px-3 py-1.5 rounded-full text-[11px] font-mono transition-all duration-200"
          style={{
            color: '#A78BFA',
            background: '#7C3AED10',
            border: '1px solid #7C3AED30',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = '#7C3AED60';
            (e.currentTarget as HTMLElement).style.background = '#7C3AED18';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = '#7C3AED30';
            (e.currentTarget as HTMLElement).style.background = '#7C3AED10';
          }}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

// ── Chat message ────────────────────────────────────────────────────────────

function ChatMessage({ role, content }: { role: 'user' | 'coach'; content: string }) {
  if (role === 'user') {
    return (
      <div className="flex justify-end mb-4 fade-in-up">
        <div
          className="max-w-[75%] px-4 py-3 rounded-lg rounded-br-sm"
          style={{
            background: '#7C3AED18',
            border: '1px solid #7C3AED33',
          }}
        >
          <p className="text-sm leading-relaxed" style={{ color: '#E8EFFF' }}>
            {content}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-4 fade-in-up">
      <div className="max-w-[80%]">
        <span
          className="text-[9px] font-mono font-bold tracking-[0.15em] uppercase mb-1 block"
          style={{ color: '#A78BFA' }}
        >
          COACH
        </span>
        <div
          className="px-4 py-3 rounded-lg rounded-bl-sm"
          style={{
            background: '#0D1221',
            borderLeft: '3px solid #00D4FF44',
          }}
        >
          <div className="prose-coach text-sm leading-relaxed" style={{ color: '#B0BCDB' }}>
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Loading indicator ───────────────────────────────────────────────────────

function ThinkingIndicator() {
  return (
    <div className="flex justify-start mb-4">
      <div>
        <span
          className="text-[9px] font-mono font-bold tracking-[0.15em] uppercase mb-1 block"
          style={{ color: '#A78BFA' }}
        >
          COACH
        </span>
        <div
          className="px-4 py-3 rounded-lg rounded-bl-sm flex items-center gap-2"
          style={{ background: '#0D1221', borderLeft: '3px solid #00D4FF44' }}
        >
          <div
            className="w-3 h-3 border border-t-transparent rounded-full animate-spin"
            style={{ borderColor: '#00D4FF30', borderTopColor: '#00D4FF' }}
          />
          <span className="text-[11px] font-mono" style={{ color: '#3D4F6E' }}>
            THINKING...
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function CoachChat() {
  const messages = useCoachStore((s) => s.messages);
  const chatLoading = useCoachStore((s) => s.chatLoading);
  const sendMessage = useCoachStore((s) => s.sendMessage);
  const initGreeting = useCoachStore((s) => s.initGreeting);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Init greeting on mount
  useEffect(() => {
    initGreeting();
  }, [initGreeting]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, chatLoading]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || chatLoading) return;
    setInput('');
    sendMessage(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isGreetingPhase = messages.length <= 1 && messages[0]?.type === 'greeting';
  const showSuggestions = isGreetingPhase && !chatLoading;

  return (
    <div className="h-full flex flex-col">
      {/* Messages area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto px-6 py-4"
        style={{
          maskImage:
            'linear-gradient(to bottom, transparent 0%, black 3%, black 97%, transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent 0%, black 3%, black 97%, transparent 100%)',
        }}
      >
        {/* Loading greeting */}
        {messages.length === 0 && chatLoading && (
          <div className="flex items-center justify-center py-20">
            <div
              className="w-5 h-5 border-2 rounded-full animate-spin"
              style={{ borderColor: '#7C3AED30', borderTopColor: '#7C3AED' }}
            />
            <span className="ml-3 text-xs font-mono" style={{ color: '#3D4F6E' }}>
              Coach is waking up...
            </span>
          </div>
        )}

        {/* Greeting */}
        {isGreetingPhase && messages[0] && <GreetingMessage text={messages[0].content} />}

        {/* Suggestion chips after greeting */}
        {showSuggestions && <SuggestionChips onSelect={(text) => sendMessage(text)} />}

        {/* Regular messages (skip greeting if shown above) */}
        {!isGreetingPhase &&
          messages.map((msg) => <ChatMessage key={msg.id} role={msg.role} content={msg.content} />)}

        {/* Thinking */}
        {chatLoading && messages.length > 0 && !isGreetingPhase && <ThinkingIndicator />}
      </div>

      {/* Context label */}
      <div className="px-6 pt-2 pb-1 flex items-center gap-1.5" style={{ background: '#0A0E1A' }}>
        <span
          className="text-[9px] font-mono tracking-[0.15em] uppercase"
          style={{ color: '#3D4F6E' }}
        >
          KNOWS:
        </span>
        <span className="text-[9px] font-mono" style={{ color: '#5A6B8A' }}>
          your full coaching memory — observations, eras, skills, drills
        </span>
      </div>

      {/* Input bar */}
      <div
        className="px-6 py-3 flex items-center gap-3"
        style={{ borderTop: '1px solid #1A2440', background: '#0A0E1A' }}
      >
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask your coach anything..."
          disabled={chatLoading}
          className="flex-1 bg-transparent text-sm font-mono outline-none"
          style={{
            color: '#E8EFFF',
            caretColor: '#7C3AED',
          }}
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || chatLoading}
          className="px-4 py-1.5 rounded-sm text-[10px] font-mono font-bold tracking-wider uppercase transition-all duration-200"
          style={{
            background:
              input.trim() && !chatLoading
                ? 'linear-gradient(135deg, #7C3AED, #5B21B6)'
                : '#1A2440',
            color: input.trim() && !chatLoading ? '#E8EFFF' : '#3D4F6E',
            border: 'none',
            cursor: input.trim() && !chatLoading ? 'pointer' : 'default',
          }}
        >
          SEND
        </button>
      </div>
    </div>
  );
}
