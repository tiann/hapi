<template>
    <div class="steps">
        <slot />
    </div>
</template>

<style scoped>
.steps {
    position: relative;
    padding-left: 1.5rem;
    margin: 1.5rem 0;
    counter-reset: step;
}

.steps::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--vp-c-divider);
}

.steps :deep(h2),
.steps :deep(h3) {
    position: relative;
    margin-top: 0;
    padding-top: 0.5rem;
    border-top: none;
}

.steps :deep(h2)::before,
.steps :deep(h3)::before {
    content: counter(step);
    counter-increment: step;
    position: absolute;
    left: -2.25rem;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    background: var(--vp-c-brand-1);
    color: var(--vp-c-white);
    font-size: 0.875rem;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
}

.steps :deep(h2) .header-anchor,
.steps :deep(h3) .header-anchor {
    display: none;
}
</style>
