import UIKit
import Capacitor

class VaultViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(VaultMediaPlugin())
    }
}
