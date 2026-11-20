import { MarButton } from '@myagentroam/mar-ui/button';
import { MarInput } from '@myagentroam/mar-ui/input';
import { MarSelect } from '@myagentroam/mar-ui/select';
import { createApp, h, ref } from 'vue';
import '../../src/styles.css';

createApp({
  setup() {
    const query = ref('Initial');
    const events = ref<string[]>([]);
    const phase = ref(0);
    const notes = ref('First line');
    const searches = ref(0);
    return () =>
      h('main', { style: { maxWidth: '25rem', margin: '1rem' } }, [
        h('label', { for: 'query' }, 'Query'),
        h(MarInput, {
          id: 'query',
          modelValue: query.value,
          'data-phase': phase.value,
          clearable: true,
          onCompositionstart: () => {
            phase.value += 1;
          },
          'onUpdate:modelValue': (value: string) => {
            query.value = value;
            events.value.push(`model:${value}`);
          },
          onInput: (value: string) => events.value.push(`input:${value}`),
          onChange: (value: string) => events.value.push(`change:${value}`),
          onClear: () => events.value.push('clear')
        }),
        h('output', { 'aria-label': 'Input events' }, events.value.join('|')),
        h('label', { for: 'notes' }, 'Notes'),
        h(MarInput, {
          id: 'notes',
          modelValue: notes.value,
          type: 'textarea',
          autosize: { minRows: 1, maxRows: 3 },
          maxlength: 60,
          showWordLimit: true,
          'onUpdate:modelValue': (value: string) => (notes.value = value)
        }),
        h(
          MarInput,
          { class: 'search-group', 'aria-label': 'Search terms', placeholder: 'Enter a term' },
          {
            append: () =>
              h(MarButton, { icon: 'search', onClick: () => searches.value++ }, () => 'Search')
          }
        ),
        h('output', { 'aria-label': 'Search actions' }, searches.value),
        h('div', { class: 'mar-management-page' }, [
          h('label', { class: 'mar-filter-field', for: 'resource' }, [
            h('span', 'Workspace'),
            h(MarInput, { id: 'resource', placeholder: 'Name or ID' })
          ]),
          h('label', { class: 'mar-filter-field', for: 'owner' }, [
            h('span', 'Owner'),
            h(MarSelect, { id: 'owner', placeholder: 'Owner type' })
          ])
        ])
      ]);
  }
}).mount('#app');
