-- Аудит 27.11 (CODE-1): проданный букет нельзя вернуть на витрину.
-- В 0014 автомат статусов разрешал переход sold → on_showcase (задел под отмену продажи, которой нет).
-- Из-за этого «На витрину» со старого экрана возвращал проданный букет: его можно было продать второй раз
-- (второе начисление мёда) или разобрать (проданные стебли возвращались на склад).
-- Когда появится отмена продажи, переход будет разрешён только внутри её пакета.
DROP TRIGGER IF EXISTS stock_bouquets_transition;
CREATE TRIGGER stock_bouquets_transition BEFORE UPDATE OF status ON stock_bouquets
WHEN NOT (OLD.status IN ('assembled','on_showcase') AND NEW.status IN ('on_showcase','sold','disassembled','written_off','cancelled') AND NEW.status <> OLD.status)
BEGIN SELECT RAISE(ABORT, 'stock: букет уже продан, разобран или списан'); END;

-- Аудит 27.11 (CODE-7): сумма оплаты мёдом фиксируется из предпросмотра, который видел клиент,
-- а не пересчитывается в момент проведения. NULL — старые продажи и клиенты без суммы (прежнее поведение).
ALTER TABLE stock_sales ADD COLUMN redeem_points INTEGER CHECK (redeem_points IS NULL OR redeem_points >= 0);
