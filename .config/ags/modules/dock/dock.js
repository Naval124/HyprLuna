const { Gtk, GLib } = imports.gi;
import Widget from 'resource:///com/github/Aylur/ags/widget.js';
import * as Utils from 'resource:///com/github/Aylur/ags/utils.js';
const { EventBox} = Widget;
import { RoundedCorner } from './../.commonwidgets/cairo_roundedcorner.js';
import Hyprland from 'resource:///com/github/Aylur/ags/service/hyprland.js';
import Applications from 'resource:///com/github/Aylur/ags/service/applications.js';
const { Box, Revealer } = Widget;
import { setupCursorHover } from '../.widgetutils/cursorhover.js';
import { getAllFiles } from './icons.js'
import { substitute } from '../.miscutils/icons.js';
import { getValidIcon } from '../.miscutils/icon_handling.js';

const icon_files = userOptions.asyncGet().icons.searchPaths.map(e => getAllFiles(e)).flat(1)
let dockSize = userOptions.asyncGet().dock.dockSize
let elevate = userOptions.asyncGet().etc.widgetCorners ? "dock-bg dock-round " : "elevation dock-bg"
let appSpacing = dockSize / 15
let isPinned = false
let cachePath = new Map()

let timers = []

function clearTimes() {
    timers.forEach(e => GLib.source_remove(e))
    timers = []
}

function ExclusiveWindow(client) {
    const fn = [
        (client) => !(client !== null && client !== undefined),
        // Jetbrains
        (client) => client.title.includes("win"),
        // Vscode
        (client) => client.title === '' && client.class === ''
    ]

    for (const item of fn) { if (item(client)) { return true } }
    return false
}

const focus = ({ address }) => Utils.execAsync(`hyprctl dispatch focuswindow address:${address}`).catch(print);

const getIconPath = (appClass, fromCache = true) => {
    return getValidIcon(appClass, icon_files, fromCache, cachePath);
};

const DockSeparator = (props = {}) => Box({
    ...props,
    className: 'dock-separator',
})

const PinButton = () => Widget.Button({
    tooltipText: 'Pin Dock',
    css: `margin: 0 ${appSpacing}px;padding: 0 10px`,
    child: Widget.Box({
        homogeneous: true,
        child: Widget.Icon({
            icon:"logo-symbolic",
            size:dockSize
        })
    }),
    onClicked: (self) => {
        isPinned = !isPinned
        self.className = `${isPinned ? "pinned-dock-app-btn dock-app-btn-animate" : "unpinned-dock-app-btn dock-app-btn-animate"}`
    },
    setup: setupCursorHover,
})

const AppButton = ({ icon, ...rest }) => Widget.Revealer({
    attribute: {
        'workspace': 0
    },
    revealChild: false,
    transition: 'slide_right',
    transitionDuration: userOptions.asyncGet().animations.durationLarge,
    child: Widget.Button({
        ...rest,
        className: 'dock-app-btn dock-app-btn-animate',
        css: `margin: 0 ${appSpacing}px`,
        child: Widget.Box({
            child: Widget.Overlay({
                child: Widget.Box({
                    homogeneous: true,
                    className: 'dock-app-icon',
                    child: Widget.Icon({
                        icon: icon,
                        size:dockSize
                    }),
                }),
                overlays: [Widget.Box({
                    class_name: 'indicator',
                    vpack: 'end',
                    hpack: 'center',
                })],
            }),
        }),
        setup: (button) => {
            setupCursorHover(button);
        }
    })
});

const Taskbar = (monitor) => Widget.Box({
    className: 'dock-apps',
    attribute: {
        monitor: monitor,
        'map': new Map(),
        'clientSortFunc': (a, b) => {
            return a.attribute.workspace > b.attribute.workspace;
        },
        'update': (box, monitor) => {
            for (let i = 0; i < Hyprland.clients.length; i++) {
                const client = Hyprland.clients[i];
                if (client["pid"] == -1) return;
                const appClass = substitute(client.class);
                const path = getIconPath(appClass);
                const newButton = AppButton({
                    icon: path,
                    tooltipText: `${client.title} (${appClass})`,
                    onClicked: () => focus(client),
                });
                newButton.attribute.workspace = client.workspace.id;
                newButton.revealChild = true;
                box.attribute.map.set(client.address, newButton);
            }
            box.children = Array.from(box.attribute.map.values());
        },
        'add': (box, address, monitor) => {
            if (!address) {
                box.attribute.update(box);
                return;
            }
            const newClient = Hyprland.clients.find(client => {
                return client.address == address;
            });
            if (ExclusiveWindow(newClient)) { return }
            const appClass = newClient.class;
            const path = getIconPath(appClass);
            const newButton = AppButton({
                icon: path,
                tooltipText: `${newClient.title} (${appClass})`,
                onClicked: () => focus(newClient),
            })
            newButton.attribute.workspace = newClient.workspace.id;
            box.attribute.map.set(address, newButton);
            box.children = Array.from(box.attribute.map.values());
            newButton.revealChild = true;
        },
        'remove': (box, address) => {
            if (!address) return;

            const removedButton = box.attribute.map.get(address);
            if (!removedButton) return;
            removedButton.revealChild = false;

            // Store the timeout ID so we can clean it up if needed
            const timeoutId = Utils.timeout(userOptions.asyncGet().animations.durationLarge, () => {
                // Check if the widget still exists before trying to destroy it
                if (removedButton && !removedButton.is_destroyed) {
                    try {
                        removedButton.destroy();
                    } catch (error) {
                        console.log(`Error destroying button: ${error.message}`);
                    }
                }

                // Update the map and children only if the box still exists
                if (box && !box.is_destroyed) {
                    box.attribute.map.delete(address);
                    try {
                        box.children = Array.from(box.attribute.map.values());
                    } catch (error) {
                        console.log(`Error updating box children: ${error.message}`);
                    }
                }
            })

            // Register the timeout for cleanup
            if (globalThis.cleanupRegistry) {
                globalThis.cleanupRegistry.registerTimeout(timeoutId);
            }
        },
    },
    setup: (self) => {
        self.hook(Hyprland, (box, address) => box.attribute.add(box, address, self.monitor), 'client-added')
            .hook(Hyprland, (box, address) => box.attribute.remove(box, address, self.monitor), 'client-removed')
        Utils.timeout(100, () => self.attribute.update(self));
    },
});

const PinnedApps = () => Widget.Box({
    class_name: 'dock-apps',
    homogeneous: true,
    children: userOptions.asyncGet().dock.pinnedApps
        .map(term => ({ app: Applications.query(term)?.[0], term }))
        .filter(({ app }) => app)
        .map(({ app, term = true }) => {
            const icon = userOptions.asyncGet().dock.searchPinnedAppIcons
                ? getIconPath(app.name, false)  // Don't use cache for pinned apps
                : app.icon_name || getIconPath(app.name, false);

            const newButton = AppButton({
                icon: icon,
                onClicked: () => {
                    for (const client of Hyprland.clients) {
                        if (client.class.toLowerCase().includes(term))
                            return focus(client);
                    }
                    app.launch();
                },
                onMiddleClick: () => app.launch(),
                tooltipText: app.name,
                setup: (self) => {
                    self.revealChild = true;
                    self.hook(Hyprland, button => {
                        const running = Hyprland.clients
                            .find(client => client.class.toLowerCase().includes(term)) || false;

                        button.toggleClassName('notrunning', !running);
                        button.toggleClassName('focused', Hyprland.active.client.address == running?.address);
                        button.set_tooltip_text(running ? running.title : app.name);
                    }, 'notify::clients')
                },
            });
            newButton.revealChild = true;
            return newButton;
        }),
});
export default (monitor = 0) => {
    const dockContent = Box({
        children:[
            userOptions.asyncGet().etc.widgetCorners ? RoundedCorner('bottomright', {vpack:"end",className: 'corner corner-colorscheme'}) : null,
            Box({
                className: `${elevate}`,
                css:`padding:${dockSize / 85}rem`,
                children:[
                    PinButton(),
                    PinnedApps(),
                    DockSeparator(),
                    Taskbar(),
                ]}),
            userOptions.asyncGet().etc.widgetCorners ? RoundedCorner('bottomleft',{vpack:"end", className: 'corner corner-colorscheme'}) : null,
        ]
    })
    const dockRevealer = Revealer({
        attribute: {
            'updateShow': self => { // I only use mouse to resize. I don't care about keyboard resize if that's a thing
                if (userOptions.asyncGet().dock.monitorExclusivity)
                    self.revealChild = Hyprland.active.monitor.id === monitor;
                else
                    self.revealChild = true;

                return self.revealChild
            }
        },
        revealChild: false,
        transition: 'slide_up',
        transitionDuration: userOptions.asyncGet().animations.durationSmall,
        child: dockContent,
        setup: (self) => {
            const callback = (self, trigger) => {
                if (!userOptions.asyncGet().dock.trigger.includes(trigger)) return
                const flag = self.attribute.updateShow(self)

                if (flag) clearTimes();

                const hidden = userOptions.asyncGet().dock.autoHide.find(e => e["trigger"] === trigger)

                if (hidden) {
                    let id = Utils.timeout(hidden.interval, () => {
                        if (!isPinned) { self.revealChild = false }
                        timers = timers.filter(e => e !== id)
                    })
                    timers.push(id)
                }
            }

            self
                // .hook(Hyprland, (self) => self.attribute.updateShow(self))
                .hook(Hyprland.active.workspace, self => callback(self, "workspace-active"))
                .hook(Hyprland.active.client, self => callback(self, "client-active"))
                .hook(Hyprland, self => callback(self, "client-added"), "client-added")
                .hook(Hyprland, self => callback(self, "client-removed"), "client-removed")
        },
    })
    return EventBox({
        onHover: () => {
            dockRevealer.revealChild = true;
            clearTimes()
        },
        child: Box({
            homogeneous: true,
            css: `min-height: ${userOptions.asyncGet().dock.hiddenThickness}px;`,
            children: [dockRevealer],
        }),
        setup: self => self.on("leave-notify-event", () => {
            if (!isPinned) dockRevealer.revealChild = false;
            clearTimes()
        })
    })
}
