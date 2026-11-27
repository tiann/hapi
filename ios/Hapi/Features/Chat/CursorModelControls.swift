import HapiProtocol
import SwiftUI

struct CursorModelControls: View {
    let catalog: CursorModelCatalog
    let selection: String?
    let onSelect: (String) -> Void

    var body: some View {
        let wire = CursorModelCatalog.selectionValue(selection)
        let family = catalog.family(for: wire)
        Picker("Model", selection: Binding(
            get: { wire == "auto" ? "auto" : family },
            set: { next in
                guard let next, next != family else { return }
                if next == "auto" {
                    guard wire != "auto" else { return }
                    onSelect("auto")
                } else if let id = catalog.defaultWire(for: next) {
                    onSelect(id)
                }
            }
        )) {
            Text("Auto").tag(String?.some("auto"))
            if wire != "auto", family == nil {
                (wire == "default" ? Text("Default") : Text(verbatim: wire)).tag(String?.none).disabled(true)
            }
            ForEach(catalog.families, id: \.self) { key in
                Text(verbatim: catalog.label(for: key)).tag(Optional(key))
            }
        }

        ForEach(Array(catalog.fields(for: wire).enumerated()), id: \.offset) { _, field in
            Picker(LocalizedStringKey(field.title), selection: Binding(
                get: { field.choices.firstIndex { $0.wire == wire } ?? 0 },
                set: { index in
                    if field.choices.indices.contains(index), let target = field.choices[index].wire, target != wire {
                        onSelect(target)
                    }
                }
            )) {
                ForEach(Array(field.choices.enumerated()), id: \.offset) { index, choice in
                    Text(LocalizedStringKey(choice.label)).tag(index).disabled(choice.wire == nil)
                }
            }
        }
    }
}
