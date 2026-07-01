function stepNumberInput(input, direction) {
  const min = Number.parseFloat(input.min);
  const max = Number.parseFloat(input.max);
  const increment = Number.parseFloat(input.step) || 1;
  let value = Number.parseFloat(input.value);

  if (!Number.isFinite(value)) {
    value = Number.isFinite(min) ? min : 0;
  }

  value += direction * increment;

  if (Number.isFinite(min)) {
    value = Math.max(min, value);
  }
  if (Number.isFinite(max)) {
    value = Math.min(max, value);
  }

  if (increment >= 1 && Number.isInteger(increment)) {
    value = Math.round(value);
  }

  input.value = String(value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function initParamSteppers(form) {
  if (!form) {
    return;
  }

  for (const stepper of form.querySelectorAll(".param-stepper")) {
    const input = stepper.querySelector('input[type="number"]');
    const decBtn = stepper.querySelector('.param-step-btn[data-step="-1"]');
    const incBtn = stepper.querySelector('.param-step-btn[data-step="1"]');
    if (!input || !decBtn || !incBtn) {
      continue;
    }

    decBtn.addEventListener("click", () => stepNumberInput(input, -1));
    incBtn.addEventListener("click", () => stepNumberInput(input, 1));
  }
}
