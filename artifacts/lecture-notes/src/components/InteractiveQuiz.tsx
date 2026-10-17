import { useState } from "react";
import { CheckCircle2, XCircle, RotateCcw, Award, ChevronRight, ChevronLeft, Sparkles } from "lucide-react";

export interface QuizQuestionItem {
  id: number;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

interface InteractiveQuizProps {
  quizMarkdown: string;
  title: string;
  onSwitchToMarkdown?: () => void;
}

export function InteractiveQuiz({ quizMarkdown, title }: InteractiveQuizProps) {
  const questions = parseQuizMarkdown(quizMarkdown);

  const [currentIdx, setCurrentIdx] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, number>>({});

  if (questions.length === 0) {
    return null;
  }

  const currentQ = questions[currentIdx];
  const userSelection = selectedAnswers[currentIdx];
  const isAnswered = userSelection !== undefined;

  const totalAnswered = Object.keys(selectedAnswers).length;
  const score = questions.reduce((acc, q, idx) => {
    return selectedAnswers[idx] === q.correctIndex ? acc + 1 : acc;
  }, 0);

  const handleSelectOption = (optIdx: number) => {
    if (isAnswered) return;
    setSelectedAnswers((prev) => ({ ...prev, [currentIdx]: optIdx }));
  };

  const handleReset = () => {
    setSelectedAnswers({});
    setCurrentIdx(0);
  };

  const letters = ["A", "B", "C", "D"];

  return (
    <div className="space-y-6 animate-slide-up">
      {/* Quiz Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl border border-border bg-card/80 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-500 border border-amber-500/20 grid place-items-center">
            <Award className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-semibold text-base">{title || "Practice Quiz"}</h3>
            <p className="text-xs text-muted-foreground">
              {questions.length} Concept-Based MCQs · Interactive Study Mode
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {totalAnswered > 0 && (
            <span className="px-3 py-1 rounded-full text-xs font-semibold bg-primary/10 text-primary border border-primary/20">
              Score: {score} / {questions.length} ({Math.round((score / questions.length) * 100)}%)
            </span>
          )}
          <button
            onClick={handleReset}
            className="p-2 rounded-lg border border-border bg-background hover:bg-secondary text-xs font-medium flex items-center gap-1.5 transition"
            title="Reset Quiz"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Reset
          </button>
        </div>
      </div>

      {/* Question Progress Bar */}
      <div className="space-y-2">
        <div className="flex justify-between items-center text-xs font-medium text-muted-foreground">
          <span>Question {currentIdx + 1} of {questions.length}</span>
          <span>{Math.round(((currentIdx + 1) / questions.length) * 100)}% Completed</span>
        </div>
        <div className="w-full h-2 rounded-full bg-secondary overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-primary to-accent transition-all duration-300 rounded-full"
            style={{ width: `${((currentIdx + 1) / questions.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Main MCQ Card */}
      <div className="surface rounded-2xl border border-border p-6 shadow-sm space-y-6">
        {/* Question Text */}
        <div className="space-y-2">
          <span className="inline-block px-2.5 py-0.5 rounded-md text-[11px] font-bold uppercase tracking-wider bg-primary/10 text-primary border border-primary/20">
            Question {currentIdx + 1}
          </span>
          <h4 className="text-base sm:text-lg font-semibold text-foreground leading-relaxed">
            {currentQ.question}
          </h4>
        </div>

        {/* Options Grid */}
        <div className="grid grid-cols-1 gap-3">
          {currentQ.options.map((opt, optIdx) => {
            const isSelected = userSelection === optIdx;
            const isCorrect = optIdx === currentQ.correctIndex;
            let statusStyle = "border-border bg-card hover:border-primary/40 hover:bg-secondary/40 text-foreground";

            if (isAnswered) {
              if (isCorrect) {
                statusStyle = "border-emerald-500/80 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100 font-medium ring-1 ring-emerald-500/30";
              } else if (isSelected) {
                statusStyle = "border-destructive/80 bg-destructive/10 text-destructive-foreground font-medium ring-1 ring-destructive/30";
              } else {
                statusStyle = "border-border/40 bg-card/40 opacity-60";
              }
            }

            return (
              <button
                key={optIdx}
                disabled={isAnswered}
                onClick={() => handleSelectOption(optIdx)}
                className={`w-full p-4 rounded-xl border text-left transition-all duration-200 flex items-start gap-3.5 group relative ${statusStyle}`}
              >
                <div
                  className={`w-7 h-7 rounded-lg border text-xs font-bold flex items-center justify-center shrink-0 transition-colors ${
                    isAnswered && isCorrect
                      ? "bg-emerald-500 text-white border-emerald-500"
                      : isAnswered && isSelected
                      ? "bg-destructive text-white border-destructive"
                      : "bg-secondary text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary group-hover:border-primary/30"
                  }`}
                >
                  {letters[optIdx]}
                </div>

                <div className="flex-1 text-xs sm:text-sm leading-relaxed pt-0.5">
                  {opt}
                </div>

                {isAnswered && isCorrect && (
                  <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 self-center" />
                )}
                {isAnswered && isSelected && !isCorrect && (
                  <XCircle className="w-5 h-5 text-destructive shrink-0 self-center" />
                )}
              </button>
            );
          })}
        </div>

        {/* Explanation Box */}
        {isAnswered && (
          <div className="p-4 rounded-xl border border-primary/20 bg-primary/5 text-sm space-y-1.5 animate-slide-up">
            <div className="flex items-center gap-2 font-semibold text-primary">
              <Sparkles className="w-4 h-4" />
              <span>Explanation &amp; Insight</span>
            </div>
            <p className="text-muted-foreground leading-relaxed text-xs sm:text-sm">
              {currentQ.explanation}
            </p>
          </div>
        )}
      </div>

      {/* Pagination Footer */}
      <div className="flex items-center justify-between gap-3 pt-2">
        <button
          disabled={currentIdx === 0}
          onClick={() => setCurrentIdx((i) => i - 1)}
          className="px-4 py-2.5 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-40 text-xs font-semibold flex items-center gap-1.5 transition"
        >
          <ChevronLeft className="w-4 h-4" /> Previous
        </button>

        <span className="text-xs text-muted-foreground font-medium">
          {currentIdx + 1} / {questions.length}
        </span>

        <button
          disabled={currentIdx === questions.length - 1}
          onClick={() => setCurrentIdx((i) => i + 1)}
          className="px-4 py-2.5 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 text-xs font-semibold flex items-center gap-1.5 shadow-sm transition"
        >
          Next <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function parseQuizMarkdown(md: string): QuizQuestionItem[] {
  const items: QuizQuestionItem[] = [];
  const blocks = md.split(/\n(?=---|(?:\*\*Q\d+[\.\:]\*\*))/g);

  let id = 1;
  for (const block of blocks) {
    const qMatch = block.match(/(?:\*\*Q\d+[\.\:]\*\*|\*\*Question\s+\d+[\.\:]\*\*|Q\d+[\.\:])\s*([\s\S]+?)(?=\n\s*[-*]\s*|\n\s*\*\*Answer|\n\s*A\))/i);
    if (!qMatch) continue;

    const question = qMatch[1].trim();

    const optionMatches = [...block.matchAll(/[-*]?\s*(?:\*\*)?([A-D])[\)\.]\s*(?:\*\*)?\s*(.+)/gi)];
    if (optionMatches.length < 4) continue;

    const options: string[] = [];
    for (let i = 0; i < 4; i++) {
      options.push(optionMatches[i][2].trim());
    }

    const ansMatch = block.match(/\*\*Answer:\*\*\s*(?:\*\*)?([A-D])(?:\*\*)?(?:\s*[\:\—\-]\s*(.+))?/i) ||
                     block.match(/Answer:\s*([A-D])(?:\s*[\:\—\-]\s*(.+))?/i);
    const correctLetter = ansMatch ? ansMatch[1].toUpperCase() : "A";
    const explanation = ansMatch && ansMatch[2]
      ? ansMatch[2].replace(/^(\*|\s)*Explanation:(\*|\s)*/gi, "").trim()
      : "Correct answer based on the lecture concepts.";

    const letterToIndex: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
    const correctIndex = letterToIndex[correctLetter] ?? 0;

    items.push({
      id: id++,
      question,
      options,
      correctIndex,
      explanation,
    });
  }

  return items;
}
