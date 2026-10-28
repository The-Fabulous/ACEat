const questions = {
  math: [
    { category: 'ALGEBRA', text: 'If 3x + 7 = 22, what is the value of x?', options: ['3', '5', '7', '9'], answer: 1, explanation: 'Вычтем 7 из обеих частей: 3x = 15. Делим на 3 и получаем x = 5.' },
    { category: 'PERCENTAGES', text: 'A jacket costs $80. Its price is reduced by 25%. What is the new price?', options: ['$20', '$55', '$60', '$75'], answer: 2, explanation: 'Скидка составляет 80 × 0,25 = 20 долларов. Новая цена: 80 − 20 = 60 долларов.' },
    { category: 'FUNCTIONS', text: 'If f(x) = 2x² − 3, what is f(4)?', options: ['13', '25', '29', '61'], answer: 2, explanation: 'Подставляем 4: f(4) = 2 × 16 − 3 = 29.' }
  ],
  reading: [
    { category: 'STANDARD ENGLISH CONVENTIONS', text: 'Choose the correct word: “Each of the students ___ a calculator.”', options: ['have', 'has', 'are having', 'were having'], answer: 1, explanation: 'Подлежащее each — единственное число. Поэтому используется has.' },
    { category: 'TRANSITIONS', text: '“The experiment was carefully designed. ___, its results were inconclusive.” Which transition best completes the text?', options: ['Therefore', 'Similarly', 'For example', 'However'], answer: 3, explanation: 'Второе предложение противопоставляет результат ожиданиям. However означает «однако» и передаёт этот контраст.' },
    { category: 'WORDS IN CONTEXT', text: '“The scientist was meticulous, checking every measurement twice.” As used here, “meticulous” most nearly means:', options: ['Careful', 'Impatient', 'Creative', 'Uncertain'], answer: 0, explanation: 'Проверка каждого измерения дважды указывает на внимательность и точность: careful.' }
  ]
};
let subject = 'math';
const positions = { math: 0, reading: 0 };
const responses = new Map();
const question = document.getElementById('question');
const answers = document.getElementById('answers');
const feedback = document.getElementById('feedback');
function render() {
  const index = positions[subject];
  const item = questions[subject][index];
  const key = `${subject}-${index}`;
  const selected = responses.get(key);
  document.getElementById('category').textContent = item.category;
  document.getElementById('counter').textContent = `${index + 1} / ${questions[subject].length}`;
  question.textContent = item.text;
  answers.replaceChildren();
  item.options.forEach((option, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'answer';
    button.textContent = `${String.fromCharCode(65 + i)}. ${option}`;
    if (selected !== undefined) {
      button.disabled = true;
      if (i === item.answer) button.classList.add('correct');
      else if (i === selected) button.classList.add('wrong');
    }
    button.addEventListener('click', () => { responses.set(key, i); render(); });
    answers.append(button);
  });
  feedback.textContent = selected === undefined ? 'Выбери ответ, чтобы увидеть объяснение.' : `${selected === item.answer ? 'Верно!' : 'Пока не совсем.'} ${item.explanation}`;
  let correct = 0;
  responses.forEach((value, key) => {
    const [group, number] = key.split('-');
    if (questions[group][Number(number)].answer === value) correct++;
  });
  document.getElementById('progress').textContent = `Верных ответов: ${correct} из ${responses.size}`;
}
document.querySelectorAll('[data-subject]').forEach(tab => {
  tab.addEventListener('click', () => {
    subject = tab.dataset.subject;
    document.querySelectorAll('[data-subject]').forEach(button => {
      const active = button === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    render();
  });
});
document.getElementById('next').addEventListener('click', () => {
  positions[subject] = (positions[subject] + 1) % questions[subject].length;
  render();
});
render();
