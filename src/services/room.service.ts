export interface RoomAuthorizer {
  canAccess(roomId: string, uid: string): Promise<boolean>;
}

// US-06 debe proporcionar el contrato de pertenencia antes de habilitar el acceso.
export const denyRoomAccess: RoomAuthorizer = {
  async canAccess() {
    return false;
  },
};
