import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { useAnalysisStore } from '../../stores/analysisStore';

const MAX_QUESTIONS = 15;
const SHOW_REMAINING_AT = 3; // only surface the counter once user is close to the limit

export function MatchQnA({ matchId, onClose }: { matchId: string; onClose: () => void }) {
  const askQuestion = useAnalysisStore((s) => s.askQuestion);
  const qnaChats = useAnalysisStore((s) => s.qnaChats);
  const chat = qnaChats[matchId] ?? { messages: [], questionsUsed: 0, loading: false };

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const remaining = MAX_QUESTIONS - chat.questionsUsed;
  const limitReached = remaining <= 0;
  const showRemaining = remaining <= SHOW_REMAINING_AT && !limitReached;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.messages.length, chat.loading]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = async () => {
    const q = input.trim();
    if (!q || chat.loading || limitReached) return;
    setInput('');
    await askQuestion(matchId, q);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.85)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex flex-col overflow-hidden"
        style={{
          width: '90vw',
          maxWidth: 700,
          height: '80vh',
          maxHeight: 700,
          background: '#0A0E1A',
          border: '1px solid #1A2440',
          boxShadow: '0 0 40px #7C3AED22',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 flex-shrink-0"
          style={{ borderBottom: '1px solid #1A2440' }}
        >
          <div className="flex items-center gap-3">
            <span
              className="text-xs font-black tracking-[0.15em] uppercase"
              style={{ color: '#A78BFA' }}
            >
              ASK YOUR COACH
            </span>
            {showRemaining && (
              <span
                className="text-[9px] font-mono tracking-widest px-2 py-0.5"
                style={{
                  color: '#FF2D55',
                  background: '#0D1221',
                  border: '1px solid #FF2D5533',
                }}
              >
                {remaining} LEFT
              </span>
            )}
            {limitReached && (
              <span
                className="text-[9px] font-mono tracking-widest px-2 py-0.5"
                style={{
                  color: '#FF2D55',
                  background: '#FF2D5510',
                  border: '1px solid #FF2D5544',
                }}
              >
                LIMIT REACHED
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: '1px solid #1A2440',
              color: '#7A8BAD',
              padding: '0.2rem 0.6rem',
              cursor: 'pointer',
              fontFamily: 'monospace',
              fontSize: '0.7rem',
              letterSpacing: '0.1em',
            }}
          >
            CLOSE
          </button>
        </div>

        {/* Messages area */}
        <div className="flex-1 overflow-auto p-5 space-y-4 min-h-0">
          {chat.messages.length === 0 && !chat.loading && (
            <div className="text-center py-12">
              <p className="text-sm font-bold tracking-wider mb-2" style={{ color: '#7A8BAD' }}>
                Ask questions about this match
              </p>
              <p className="text-[11px] font-mono" style={{ color: '#3D4F6E' }}>
                Your coach has full context from the analysis report.
                <br />
                Ask about specific deaths, positioning, decisions, or drills.
              </p>
            </div>
          )}

          {chat.messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className="max-w-[80%] px-4 py-3"
                style={{
                  background: msg.role === 'user' ? '#7C3AED18' : '#0D1221',
                  border: `1px solid ${msg.role === 'user' ? '#7C3AED33' : '#1A2440'}`,
                  borderLeft: msg.role === 'assistant' ? '3px solid #00D4FF44' : undefined,
                }}
              >
                {msg.role === 'assistant' && (
                  <span
                    className="block text-[9px] font-mono tracking-widest mb-1.5"
                    style={{ color: '#00D4FF' }}
                  >
                    COACH
                  </span>
                )}
                {msg.role === 'assistant' ? (
                  <div className="text-xs leading-relaxed prose-coach" style={{ color: '#B0BCDB' }}>
                    <Markdown>{msg.content}</Markdown>
                  </div>
                ) : (
                  <p
                    className="text-xs leading-relaxed whitespace-pre-wrap"
                    style={{ color: '#E8EFFF' }}
                  >
                    {msg.content}
                  </p>
                )}
              </div>
            </div>
          ))}

          {/* Loading indicator */}
          {chat.loading && (
            <div className="flex justify-start">
              <div
                className="px-4 py-3 flex items-center gap-2"
                style={{
                  background: '#0D1221',
                  border: '1px solid #1A2440',
                  borderLeft: '3px solid #00D4FF44',
                }}
              >
                <div
                  className="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin"
                  style={{ borderColor: '#00D4FF', borderTopColor: 'transparent' }}
                />
                <span className="text-[10px] font-mono" style={{ color: '#3D4F6E' }}>
                  THINKING...
                </span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Context label */}
        <div
          className="px-5 pt-2 pb-1 flex items-center gap-1.5 flex-shrink-0"
          style={{ background: '#0A0E1A' }}
        >
          <span
            className="text-[9px] font-mono tracking-[0.15em] uppercase"
            style={{ color: '#3D4F6E' }}
          >
            KNOWS:
          </span>
          <span className="text-[9px] font-mono" style={{ color: '#5A6B8A' }}>
            this match — deaths, verdict, drills, round timeline
          </span>
        </div>

        {/* Limit-reached banner */}
        {limitReached && (
          <div
            className="px-5 py-2 flex-shrink-0 flex items-center gap-2"
            style={{ background: '#FF2D5510', borderTop: '1px solid #FF2D5533' }}
          >
            <span className="text-[10px] font-mono tracking-widest" style={{ color: '#FF2D55' }}>
              DAILY LIMIT REACHED
            </span>
            <span className="text-[10px] font-mono" style={{ color: '#B0BCDB' }}>
              Come back tomorrow for fresh questions.
            </span>
          </div>
        )}

        {/* Input area */}
        <div
          className="flex items-center gap-3 px-5 py-3 flex-shrink-0"
          style={{ borderTop: '1px solid #1A2440', background: '#0D1221' }}
        >
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSend();
            }}
            disabled={limitReached || chat.loading}
            placeholder={limitReached ? 'Question limit reached' : 'Ask about your gameplay...'}
            className="flex-1 text-sm font-mono focus:outline-none"
            style={{
              background: '#0A0E1A',
              border: '1px solid #1A2440',
              padding: '0.5rem 0.75rem',
              color: '#E8EFFF',
              borderRadius: 0,
            }}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || limitReached || chat.loading}
            className="text-[10px] font-black tracking-[0.15em] uppercase px-4 py-2 transition-all"
            style={{
              background:
                input.trim() && !limitReached && !chat.loading
                  ? 'linear-gradient(135deg, #7C3AED, #7C3AEDCC)'
                  : '#1A2440',
              color: input.trim() && !limitReached && !chat.loading ? '#fff' : '#3D4F6E',
              border: 'none',
              cursor: input.trim() && !limitReached && !chat.loading ? 'pointer' : 'default',
            }}
          >
            SEND
          </button>
        </div>
      </div>
    </div>
  );
}
