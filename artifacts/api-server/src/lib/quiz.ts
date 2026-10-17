export interface QuizQuestion {
  question: string;
  options: string[]; // exactly 4 options
  correctIndex: number; // 0..3 corresponding to A, B, C, D
  explanation: string;
}

/**
 * Programmatically shuffles options for a question using Fisher-Yates algorithm
 * and updates the correctIndex accordingly.
 */
export function shuffleQuestionOptions(q: QuizQuestion): QuizQuestion {
  if (!q.options || q.options.length < 4) return q;

  const optionsWithFlags = q.options.slice(0, 4).map((opt, idx) => ({
    text: opt.trim(),
    isCorrect: idx === q.correctIndex,
  }));

  // Fisher-Yates shuffle
  for (let i = optionsWithFlags.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [optionsWithFlags[i], optionsWithFlags[j]] = [optionsWithFlags[j], optionsWithFlags[i]];
  }

  const newOptions = optionsWithFlags.map((o) => o.text);
  const newCorrectIndex = optionsWithFlags.findIndex((o) => o.isCorrect);

  return {
    question: q.question,
    options: newOptions,
    correctIndex: newCorrectIndex >= 0 ? newCorrectIndex : 0,
    explanation: q.explanation,
  };
}

/**
 * Cleans question text from timestamps, OCR noise, and video frame markers.
 */
export function cleanQuestionText(text: string): string {
  return text
    .replace(/at\s+timestamp\s+\d+:\d+(:\d+)?/gi, "")
    .replace(/at\s+\d+:\d+(:\d+)?/gi, "")
    .replace(/\[\d+:\d+(:\d+)?\]/g, "")
    .replace(/\(\s*\d+:\d+\s*\)/g, "")
    .replace(/frame\s+\d+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Enforces uniform distribution of correct answers across A, B, C, and D (indices 0, 1, 2, 3).
 */
export function enforceDistribution(questions: QuizQuestion[]): QuizQuestion[] {
  if (questions.length === 0) return questions;

  const result = questions.map((q) => shuffleQuestionOptions(q));

  // Count current correctIndex distribution
  const counts = [0, 0, 0, 0];
  result.forEach((q) => counts[q.correctIndex]++);

  // If all 4 options are used, return
  if (counts.every((c) => c > 0) || questions.length < 4) {
    return result;
  }

  // Swap correct options to target positions to ensure balanced distribution
  return result.map((q, idx) => {
    const targetIndex = idx % 4;
    if (q.correctIndex === targetIndex) return q;

    const opts = [...q.options];
    const prevCorrectOpt = opts[q.correctIndex];
    const targetOpt = opts[targetIndex];

    opts[targetIndex] = prevCorrectOpt;
    opts[q.correctIndex] = targetOpt;

    return {
      ...q,
      options: opts,
      correctIndex: targetIndex,
    };
  });
}

/**
 * Converts QuizQuestion array into clean, structured Markdown output.
 */
export function formatQuizMarkdown(title: string, questions: QuizQuestion[]): string {
  const letters = ["A", "B", "C", "D"];
  const cleanTitle = title && title.trim() ? title.trim() : "Lecture Notes";

  const questionBlocks = questions.map((q, idx) => {
    const optionsText = q.options
      .map((opt, i) => `- **${letters[i]})** ${opt}`)
      .join("\n");
    const correctLetter = letters[q.correctIndex] || "A";

    const expClean = q.explanation.replace(/^(\*|\s)*Explanation:(\*|\s)*/gi, "").trim();
    return `---
**Q${idx + 1}.** ${q.question}

${optionsText}

**Answer:** **${correctLetter}** — *Explanation:* ${expClean}`;
  });

  return `# Practice Quiz: ${cleanTitle}

${questionBlocks.join("\n\n")}`;
}

/**
 * Parses raw Markdown quiz text (from LLM or fallback), cleans timestamps,
 * programmatically shuffles options, updates correct answer indices,
 * enforces A/B/C/D distribution, and returns clean Markdown.
 */
export function parseAndEnforceQuizMarkdown(rawMarkdown: string, title: string): string {
  const questions: QuizQuestion[] = [];
  const blocks = rawMarkdown.split(/\n(?=---|(?:\*\*Q\d+[\.\:]\*\*))/g);

  for (const block of blocks) {
    const qMatch = block.match(/(?:\*\*Q\d+[\.\:]\*\*|\*\*Question\s+\d+[\.\:]\*\*|Q\d+[\.\:])\s*([\s\S]+?)(?=\n\s*[-*]\s*|\n\s*\*\*Answer|\n\s*A\))/i);
    if (!qMatch) continue;

    const rawQText = qMatch[1].trim();
    const cleanQ = cleanQuestionText(rawQText);
    if (!cleanQ || cleanQ.length < 10) continue;

    // Extract options A, B, C, D
    const optionMatches = [...block.matchAll(/[-*]?\s*(?:\*\*)?([A-D])[\)\.]\s*(?:\*\*)?\s*(.+)/gi)];
    if (optionMatches.length < 4) continue;

    const options: string[] = [];
    for (let i = 0; i < 4; i++) {
      options.push(optionMatches[i][2].trim().replace(/\s+/g, " "));
    }

    // Extract correct answer letter (A, B, C, or D)
    const ansMatch = block.match(/\*\*Answer:\*\*\s*(?:\*\*)?([A-D])(?:\*\*)?(?:\s*[\:\—\-]\s*(.+))?/i) ||
                     block.match(/Answer:\s*([A-D])(?:\s*[\:\—\-]\s*(.+))?/i);
    const correctLetter = ansMatch ? ansMatch[1].toUpperCase() : "A";
    const explanation = ansMatch && ansMatch[2] ? ansMatch[2].trim() : "Correct answer based on the lecture material.";

    const letterToIndex: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
    const correctIndex = letterToIndex[correctLetter] ?? 0;

    questions.push({
      question: cleanQ,
      options,
      correctIndex,
      explanation,
    });
  }

  if (questions.length === 0) {
    return rawMarkdown;
  }

  // Deduplicate questions
  const uniqueQuestions: QuizQuestion[] = [];
  const seenQuestions = new Set<string>();
  for (const q of questions) {
    const key = q.question.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!seenQuestions.has(key)) {
      seenQuestions.add(key);
      uniqueQuestions.push(q);
    }
  }

  // Shuffle options & enforce A/B/C/D distribution
  const processedQuestions = enforceDistribution(uniqueQuestions);
  return formatQuizMarkdown(title, processedQuestions);
}

/**
 * Generates concept-focused fallback quiz questions based on transcript text / concepts.
 */
export function generateConceptFallbackQuiz(
  title: string,
  frames: { timestamp: number; text: string }[]
): string {
  const cleanTitle = title && title.trim() ? title.trim() : "Lecture Notes";

  // Combine transcript text
  const fullText = frames
    .map((f) => f.text || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!fullText || fullText.length < 30) {
    return `# Practice Quiz: ${cleanTitle}\n\n*Not enough lecture text available to generate quiz questions.*`;
  }

  const isRatInMaze = /rat\s*in\s*a\s*maze|backtracking/i.test(fullText + cleanTitle);
  const isSql = /sql|select|where|table|database|join|query|primary key|foreign key|insert|update|delete/i.test(fullText + cleanTitle);
  const isPython = /python|def |function|variable|list|dict|tuple|loop|import|class|print/i.test(fullText + cleanTitle);

  let rawQuestions: QuizQuestion[] = [];

  if (isRatInMaze) {
    rawQuestions = [
      {
        question: "What is the primary function of the `visited` array in the Rat in a Maze backtracking algorithm?",
        options: [
          "To prevent the rat from cycling back and forth between adjacent cells and causing an infinite recursion.",
          "To store the final path string characters in reverse order.",
          "To increase memory usage to optimize CPU cache lines.",
          "To permanently delete blocked cells from the original input maze.",
        ],
        correctIndex: 0,
        explanation: "Without tracking visited cells, the rat would endlessly move back and forth between adjacent open cells, causing a Stack Overflow.",
      },
      {
        question: "Why must a cell be reset to `visited[x][y] = 0` (unmarked) when the recursive function returns?",
        options: [
          "To allow alternative valid paths to use that cell in subsequent branch explorations (the backtracking step).",
          "Because operating systems require all dynamically allocated arrays to be cleared before returning.",
          "To delete the memory allocated for the maze matrix immediately.",
          "To signal to the compiler that the function has finished executing.",
        ],
        correctIndex: 0,
        explanation: "Backtracking requires undoing the state change (unmarking the visited cell) so other paths can traverse through it.",
      },
      {
        question: "Which conditions must evaluate to true in the `isSafe` helper function before moving to cell `(newx, newy)`?",
        options: [
          "Coordinates are within bounds (0 <= newx < n, 0 <= newy < n), the cell is open (m[newx][newy] == 1), and it is unvisited (visited[newx][newy] == 0).",
          "Only that coordinates are within bounds, regardless of obstacles or visited status.",
          "The cell contains a 0 and has already been visited at least twice.",
          "The rat has fewer than 10 total moves recorded so far in the path string.",
        ],
        correctIndex: 0,
        explanation: "A safe move must remain strictly inside the grid, step on an open path (1), and avoid revisiting a cell in the current path (0).",
      },
      {
        question: "What is the worst-case time complexity of the Rat in a Maze problem on an N x N matrix?",
        options: [
          "O(4^(N^2)), because from each of the N^2 cells, up to 4 directional moves can be explored.",
          "O(N), because the rat moves in a straight line directly from start to end.",
          "O(N^2), because each cell is visited at most once across the entire program.",
          "O(log N), using binary search across the grid rows.",
        ],
        correctIndex: 0,
        explanation: "In an empty maze with all 1s, each of the N^2 cells can branch in up to 4 directions, giving an upper bound of O(4^(N^2)).",
      },
      {
        question: "What is the base case condition in the recursive `solve` function?",
        options: [
          "When the rat reaches the destination coordinate: (x == n - 1 && y == n - 1).",
          "When the path string length exceeds 100 characters.",
          "When all elements in the maze matrix are turned into 0.",
          "When the function encounters a syntax error in the call stack.",
        ],
        correctIndex: 0,
        explanation: "Reaching the destination coordinate (n - 1, n - 1) triggers the base case, where the current path string is added to the results vector.",
      },
      {
        question: "If the starting cell m[0][0] contains 0, what should the algorithm do?",
        options: [
          "Return an empty list immediately, because the rat cannot start from a blocked cell.",
          "Automatically flip m[0][0] to 1 and proceed with normal recursion.",
          "Throw a fatal runtime error and crash the program.",
          "Start searching from cell (n - 1, n - 1) backwards.",
        ],
        correctIndex: 0,
        explanation: "If the entrance (0, 0) is blocked with 0, no path can ever exist, so an empty vector is returned immediately.",
      },
      {
        question: "What is the space complexity of the Rat in a Maze backtracking algorithm on an N x N grid?",
        options: [
          "O(N^2) auxiliary space for the visited tracking matrix and recursive call stack depth.",
          "O(1) constant auxiliary space, as no extra structures are used.",
          "O(N^4) space to store intermediate matrix copies on every call.",
          "O(2^N) space allocated exclusively on the heap.",
        ],
        correctIndex: 0,
        explanation: "The algorithm uses an N x N visited grid (O(N^2)) and a recursion call stack that can reach depth N^2 in the worst-case path.",
      },
      {
        question: "In what directional order should the moves be evaluated if paths must be returned in lexicographical order?",
        options: [
          "Down ('D'), Left ('L'), Right ('R'), Up ('U') — or sorting the resulting path strings alphabetically.",
          "Up ('U'), Down ('D'), Left ('L'), Right ('R') exclusively.",
          "Random order, as sorting is impossible with strings in C++.",
          "Right ('R'), Down ('D'), Left ('L'), Up ('U') without sorting.",
        ],
        correctIndex: 0,
        explanation: "'D' < 'L' < 'R' < 'U' matches lexicographical order, and sorting the final vector ensures strict alphabetical ordering.",
      },
    ];
  } else if (isSql) {
    rawQuestions = [
      {
        question: "What is the primary purpose of the SQL SELECT statement in relational databases?",
        options: [
          "To query and retrieve specific data records from one or more database tables.",
          "To delete database tables and clear stored records permanently.",
          "To create user permissions and manage database server configurations.",
          "To compile application source code into executable binary files.",
        ],
        correctIndex: 0,
        explanation: "The SELECT statement is used to retrieve rows and columns of data from database tables based on specified criteria.",
      },
      {
        question: "Which SQL clause is used to filter records and return only rows that fulfill a specified condition?",
        options: [
          "WHERE clause",
          "GROUP BY clause",
          "ORDER BY clause",
          "HAVING clause without WHERE",
        ],
        correctIndex: 0,
        explanation: "The WHERE clause filters rows before any grouping or aggregation takes place in a SQL query.",
      },
      {
        question: "In database design, what is a Primary Key?",
        options: [
          "A column or set of columns that uniquely identifies each record in a table.",
          "A foreign key reference that connects to another table's primary key.",
          "An optional index used exclusively to format output text strings.",
          "A temporary table stored in server memory for fast calculation.",
        ],
        correctIndex: 0,
        explanation: "A Primary Key must contain UNIQUE values and cannot contain NULL values, ensuring each record can be uniquely identified.",
      },
      {
        question: "What type of SQL JOIN returns all rows from the left table, and matching rows from the right table?",
        options: [
          "LEFT JOIN (or LEFT OUTER JOIN)",
          "INNER JOIN",
          "RIGHT JOIN",
          "FULL OUTER JOIN",
        ],
        correctIndex: 0,
        explanation: "A LEFT JOIN returns all records from the left table, and matched records from the right table. Unmatched right rows return NULL.",
      },
      {
        question: "Which aggregate function in SQL calculates the total sum of numeric values in a column?",
        options: [
          "SUM()",
          "COUNT()",
          "TOTAL()",
          "AVG()",
        ],
        correctIndex: 0,
        explanation: "The SUM() function returns the total sum of a numeric column in SQL.",
      },
      {
        question: "What is the key difference between the WHERE clause and the HAVING clause in SQL?",
        options: [
          "WHERE filters individual rows before grouping, while HAVING filters aggregated groups after GROUP BY.",
          "WHERE works only on text columns, while HAVING works only on numeric columns.",
          "HAVING is used to join tables, while WHERE is used to delete records.",
          "There is no difference; WHERE and HAVING are completely interchangeable.",
        ],
        correctIndex: 0,
        explanation: "WHERE filters rows before aggregation, whereas HAVING filters groups after aggregate calculations (like SUM or COUNT).",
      },
      {
        question: "Which command is used to add new records into a SQL database table?",
        options: [
          "INSERT INTO",
          "UPDATE TABLE",
          "ADD ROW",
          "CREATE RECORD",
        ],
        correctIndex: 0,
        explanation: "The INSERT INTO statement is used to insert new records into a database table.",
      },
      {
        question: "How does NULL behave in SQL queries and boolean evaluations?",
        options: [
          "NULL represents missing or unknown data, and expressions comparing values to NULL evaluate to UNKNOWN.",
          "NULL is equal to zero (0) in numerical operations.",
          "NULL is equal to an empty string ('') in string comparisons.",
          "NULL automatically matches all values in WHERE clause filters.",
        ],
        correctIndex: 0,
        explanation: "In SQL, NULL signifies unknown or missing data. Testing for NULL requires IS NULL or IS NOT NULL rather than '=' comparison.",
      },
    ];
  } else if (isPython) {
    rawQuestions = [
      {
        question: "What is the primary characteristic of Python data structures known as Tuples?",
        options: [
          "Tuples are immutable ordered sequences, meaning their elements cannot be modified after creation.",
          "Tuples are mutable key-value mappings that allow dynamic key additions.",
          "Tuples are unordered collections of unique elements that auto-sort automatically.",
          "Tuples can only store integer numbers and cannot hold strings or objects.",
        ],
        correctIndex: 0,
        explanation: "Tuples in Python are defined with parentheses () and are immutable, making them fixed once defined.",
      },
      {
        question: "Which keyword is used in Python to define a user-created function?",
        options: [
          "def",
          "function",
          "fn",
          "define",
        ],
        correctIndex: 0,
        explanation: "The 'def' keyword introduces a function definition in Python.",
      },
      {
        question: "How does Python handle variable scope inside nested functions or blocks?",
        options: [
          "Variables created inside a function are local to that function unless declared global or nonlocal.",
          "All variables in Python are global by default across all files.",
          "Variables are strictly block-scoped to single lines of code.",
          "Variables must be declared with static type annotations before assignment.",
        ],
        correctIndex: 0,
        explanation: "Python uses LEGB (Local, Enclosing, Global, Built-in) scope hierarchy for variable resolution.",
      },
      {
        question: "What will be the output of `type([1, 2, 3])` in Python?",
        options: [
          "<class 'list'>",
          "<class 'tuple'>",
          "<class 'array'>",
          "<class 'set'>",
        ],
        correctIndex: 0,
        explanation: "Square brackets [] instantiate a Python list object.",
      },
      {
        question: "Which control flow statement is used to exit a loop prematurely in Python?",
        options: [
          "break",
          "continue",
          "pass",
          "exit",
        ],
        correctIndex: 0,
        explanation: "The break statement terminates the current loop and resumes execution at the next statement.",
      },
      {
        question: "What is the purpose of Python's `try...except` block?",
        options: [
          "To handle runtime exceptions gracefully and prevent program crashes.",
          "To speed up loop execution by skipping type checking.",
          "To import external third-party libraries automatically.",
          "To compile Python code directly to C machine code.",
        ],
        correctIndex: 0,
        explanation: "try-except blocks catch and handle exceptions during code execution.",
      },
    ];
  } else {
    // General lecture concept questions
    const sentences = fullText
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 25 && !/http|www|subtitles|transcript/i.test(s));

    const selectedSentences = sentences.slice(0, 6);

    rawQuestions = selectedSentences.map((sentence, idx) => {
      const words = sentence.split(" ");
      const mainConcept = words.slice(0, 8).join(" ");
      return {
        question: `Based on the lecture concepts, which statement accurately summarizes the discussion around "${mainConcept}..."?`,
        options: [
          sentence,
          `The lecture states the opposite: ${words.slice(4, 12).join(" ")} is irrelevant.`,
          `This concept applies only in offline legacy systems without computational support.`,
          `The topic was mentioned as a historic footnote without practical application.`,
        ],
        correctIndex: 0,
        explanation: `The lecture highlights: "${sentence.slice(0, 120)}..."`,
      };
    });
  }

  // Shuffle options & enforce uniform A/B/C/D distribution
  const enforced = enforceDistribution(rawQuestions);
  return formatQuizMarkdown(cleanTitle, enforced);
}
